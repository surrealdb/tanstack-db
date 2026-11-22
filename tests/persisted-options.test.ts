import { describe, expect, it, mock } from 'bun:test';
import * as persistenceCore from '@tanstack/db-sqlite-persistence-core';
import {
	InvalidPersistedCollectionConfigError,
	type PersistedCollectionPersistence,
	SingleProcessCoordinator,
} from '@tanstack/db-sqlite-persistence-core';
import { QueryClient } from '@tanstack/query-core';

import type { PersistedSurrealCollectionOptions } from '../src/types';

// Record what reaches persistedCollectionOptions, then call through to the real one.
const realPersistedCollectionOptions =
	persistenceCore.persistedCollectionOptions;
const persistedCollectionOptions = mock(
	(options: Record<string, unknown>) =>
		(realPersistedCollectionOptions as (input: unknown) => unknown)(options),
);
mock.module('@tanstack/db-sqlite-persistence-core', () => ({
	...persistenceCore,
	persistedCollectionOptions,
}));

const { persistedSurrealCollectionOptions } = await import('../src/index');

type Product = {
	id: string;
	name: string;
};

const persistence: PersistedCollectionPersistence = {
	adapter: {
		loadSubset: async () => [],
		loadResumeSnapshot: async () => ({
			rows: [],
			collectionMetadata: [],
			latestTerm: 0,
			latestSeq: 0,
			latestRowVersion: 0,
			resetEpoch: 0,
		}),
		applyCommittedTx: async () => undefined,
		ensureIndex: async () => undefined,
	},
	coordinator: new SingleProcessCoordinator('test-node'),
};

const createPersistedOptions = (
	overrides: Partial<PersistedSurrealCollectionOptions<Product>> = {},
) =>
	persistedSurrealCollectionOptions<Product>({
		db: {} as never,
		table: { name: 'product' },
		queryClient: new QueryClient(),
		queryKey: ['product'],
		syncMode: 'on-demand',
		persistence,
		schemaVersion: 3,
		...overrides,
	});

describe('persistedSurrealCollectionOptions option forwarding', () => {
	it('forwards every persisted-only option to persistedCollectionOptions', () => {
		persistedCollectionOptions.mockClear();
		const initialRender = {
			strategy: 'network-first',
			networkTimeoutMs: 1500,
		} as const;

		createPersistedOptions({ initialRender });

		expect(persistedCollectionOptions).toHaveBeenCalledTimes(1);
		const input = persistedCollectionOptions.mock.calls[0]?.[0];
		expect(input?.persistence).toBe(persistence);
		expect(input?.schemaVersion).toBe(3);
		expect(input?.initialRender).toEqual(initialRender);
		expect(input?.id).toEqual(expect.stringMatching(/^surreal:product:/));
		expect(typeof input?.sync).toBe('object');
	});

	it('leaves initialRender unset when it is not passed', () => {
		persistedCollectionOptions.mockClear();

		createPersistedOptions();

		const input = persistedCollectionOptions.mock.calls[0]?.[0];
		expect(input && 'initialRender' in input).toBe(false);
		expect(input?.schemaVersion).toBe(3);
	});

	it('lets persistedCollectionOptions validate initialRender', () => {
		expect(() =>
			createPersistedOptions({
				initialRender: { strategy: 'network-first', networkTimeoutMs: -1 },
			}),
		).toThrow(InvalidPersistedCollectionConfigError);
	});
});
