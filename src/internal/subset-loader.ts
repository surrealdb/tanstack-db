import type { LoadSubsetOptions } from '@tanstack/db';
import {
	CancelledError,
	type DefaultOptions,
	type QueryClient,
} from '@tanstack/query-core';

type Row = Record<string, unknown>;

type QueryDefaults = NonNullable<DefaultOptions['queries']>;

export type SubsetRetryOptions = {
	retry?: QueryDefaults['retry'];
	retryDelay?: QueryDefaults['retryDelay'];
};

const DEFAULT_CONNECTION_RETRIES = 3;

// The SDK's ESM and CommonJS builds have separate error classes, so a client
// from the other build fails `instanceof`. Its errors share this brand.
const SURREAL_ERROR = Symbol.for('surrealdb.SurrealError');
const CONNECTION_ERRORS = new Set([
	'CallTerminatedError',
	'ConnectionUnavailableError',
	'HttpConnectionError',
	'UnexpectedConnectionError',
]);

const isConnectionLoss = (error: unknown): boolean =>
	error instanceof Error &&
	(error as unknown as Record<symbol, unknown>)[SURREAL_ERROR] === true &&
	CONNECTION_ERRORS.has(error.name);

let nextLoader = 0;

type SubsetLoaderConfig = SubsetRetryOptions & {
	queryClient: QueryClient;
	queryKey: readonly unknown[];
	load: (subset: LoadSubsetOptions) => Promise<Row[]>;
};

/**
 * Runs subset SELECTs through TanStack Query for its retry handling. Every load
 * is its own uncached query: a snapshot must be read after its LIVE query opens,
 * so it can't be shared with an earlier load or served from cache.
 */
export const createSubsetLoader = ({
	queryClient,
	queryKey,
	load,
	retry,
	retryDelay,
}: SubsetLoaderConfig) => {
	// Collections can share a QueryClient and queryKey, and two copies of this
	// module can too, so a load's key must be unique across loaders.
	const loaderId = `${++nextLoader}:${Math.random().toString(36).slice(2)}`;
	let nextLoad = 0;

	return async (
		subset: LoadSubsetOptions,
		signal?: AbortSignal,
	): Promise<Row[]> => {
		const key = [...queryKey, 'surreal-subset', loaderId, ++nextLoad];
		const defaults = queryClient.defaultQueryOptions({ queryKey: key });
		const policy = retry ?? defaults.retry;
		const shouldRetry = (failures: number, error: Error): boolean => {
			if (signal?.aborted) return false;
			if (policy === undefined) {
				return (
					isConnectionLoss(error) &&
					failures < DEFAULT_CONNECTION_RETRIES
				);
			}
			if (typeof policy === 'function') return policy(failures, error);
			return typeof policy === 'number' ? failures < policy : policy;
		};
		const cancel = () => {
			void queryClient.cancelQueries({ queryKey: key, exact: true });
		};
		signal?.addEventListener('abort', cancel, { once: true });

		try {
			return await queryClient.fetchQuery({
				queryKey: key,
				queryFn: () => load(subset),
				retry: shouldRetry,
				retryDelay: retryDelay ?? defaults.retryDelay,
				staleTime: 0,
				gcTime: 0,
				// The SDK queues calls while it reconnects, so don't pause here too.
				networkMode: 'always',
				structuralSharing: false,
			});
		} catch (error) {
			if (signal?.aborted && error instanceof CancelledError) return [];
			throw error;
		} finally {
			signal?.removeEventListener('abort', cancel);
			queryClient.removeQueries({ queryKey: key, exact: true });
		}
	};
};
