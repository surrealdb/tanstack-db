import { describe, expect, it, mock } from 'bun:test';
import { BasicIndex } from '@tanstack/db';
import {
	type PersistedCollectionPersistence,
	SingleProcessCoordinator,
} from '@tanstack/db-sqlite-persistence-core';
import { QueryClient } from '@tanstack/query-core';
import * as queryDbCollection from '@tanstack/query-db-collection';

// Record what reaches queryCollectionOptions, then call through to the real one.
const realQueryCollectionOptions = queryDbCollection.queryCollectionOptions;
const queryCollectionOptions = mock((config: Record<string, unknown>) =>
	(realQueryCollectionOptions as (input: unknown) => unknown)(config),
);
mock.module('@tanstack/query-db-collection', () => ({
	...queryDbCollection,
	queryCollectionOptions,
}));

const { persistedSurrealCollectionOptions, surrealCollectionOptions } =
	await import('../src/index');

type Product = {
	id: string;
	name: string;
};

const compare = (a: Product, b: Product) => a.name.localeCompare(b.name);
const defaultStringCollation = {
	stringSort: 'locale',
	locale: 'en',
} as const;

const forwardedOptions = {
	gcTime: 12_345,
	startSync: true,
	autoIndex: 'eager',
	defaultIndexType: BasicIndex,
	compare,
	defaultStringCollation,
} as const;

const baseConfig = () => ({
	db: {} as never,
	table: { name: 'product' },
	queryClient: new QueryClient(),
	queryKey: ['product'],
	syncMode: 'eager' as const,
});

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

const expectForwarded = (options: Record<string, unknown>) => {
	expect(options.startSync).toBe(true);
	expect(options.autoIndex).toBe('eager');
	expect(options.defaultIndexType).toBe(BasicIndex);
	expect(options.compare).toBe(compare);
	expect(options.defaultStringCollation).toEqual(defaultStringCollation);
};

describe('standard collection option forwarding', () => {
	it('surrealCollectionOptions forwards standard collection options', () => {
		queryCollectionOptions.mockClear();

		const options = surrealCollectionOptions<Product>({
			...baseConfig(),
			...forwardedOptions,
		});

		expectForwarded(options as unknown as Record<string, unknown>);
		// queryCollectionOptions consumes gcTime itself, so check its input.
		const input = queryCollectionOptions.mock.calls[0]?.[0];
		expect(input?.gcTime).toBe(12_345);
		expectForwarded(input ?? {});
	});

	it('persistedSurrealCollectionOptions forwards standard collection options', () => {
		queryCollectionOptions.mockClear();

		const options = persistedSurrealCollectionOptions<Product>({
			...baseConfig(),
			...forwardedOptions,
			persistence,
			schemaVersion: 1,
		});

		expectForwarded(options as unknown as Record<string, unknown>);
		expect(queryCollectionOptions.mock.calls[0]?.[0]?.gcTime).toBe(12_345);
	});

	it('leaves unset options out of the collection config', () => {
		const options = surrealCollectionOptions<Product>(baseConfig());

		for (const key of Object.keys(forwardedOptions)) {
			expect(key in options).toBe(false);
		}
	});

	it('keeps adapter-owned options under adapter control', () => {
		const options = surrealCollectionOptions<Product>(baseConfig());

		expect(options.getKey({ id: 'product:a', name: 'A' })).toBe('product:a');
		expect(options.schema['~standard'].vendor).toBe('tanstack-db-surrealdb');
	});
});
