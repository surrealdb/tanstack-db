import { describe, expect, it } from 'bun:test';
import { createCollection } from '@tanstack/db';
import { QueryClient } from '@tanstack/query-core';
import { CallTerminatedError, RecordId } from 'surrealdb';

import { surrealCollectionOptions } from '../src/index';

type Item = { id: RecordId<'item'>; title: string };

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
const row = () => ({ id: new RecordId('item', 'a'), title: 'A' });

const setup = (
	query: (attempt: number) => Promise<unknown>,
	options: Record<string, unknown> = {},
	queryClient = new QueryClient(),
) => {
	const state = { attempts: 0 };
	const db = {
		isFeatureSupported: () => false,
		query: () => {
			state.attempts += 1;
			return query(state.attempts);
		},
	};
	const items = createCollection(
		surrealCollectionOptions<Item>({
			db: db as never,
			table: { name: 'item' },
			queryClient,
			queryKey: ['item', crypto.randomUUID()],
			syncMode: 'on-demand',
			retryDelay: 0,
			...options,
		} as never),
	);
	items.startSyncImmediate();
	return { items, state, queryClient };
};

const failOnce = (error: Error) => async (attempt: number) => {
	if (attempt === 1) throw error;
	return [[row()]];
};

describe('on-demand subset load retries', () => {
	it('retries a load the connection dropped', async () => {
		const { items, state } = setup(failOnce(new CallTerminatedError()));
		await items._sync.loadSubset({});
		expect(state.attempts).toBe(2);
		expect(items.has('item:a')).toBe(true);
	});

	it('does not retry a server or query error by default', async () => {
		const { items, state } = setup(failOnce(new Error('denied')));
		await expect(items._sync.loadSubset({})).rejects.toThrow('denied');
		expect(state.attempts).toBe(1);
	});

	it('honors the collection retry option', async () => {
		const { items, state } = setup(
			async () => {
				throw new Error('denied');
			},
			{ retry: 2 },
		);
		await expect(items._sync.loadSubset({})).rejects.toThrow('denied');
		expect(state.attempts).toBe(3);
	});

	it('lets the collection turn retries off', async () => {
		const { items, state } = setup(failOnce(new CallTerminatedError()), {
			retry: false,
		});
		await expect(items._sync.loadSubset({})).rejects.toBeInstanceOf(
			CallTerminatedError,
		);
		expect(state.attempts).toBe(1);
	});

	it('honors the QueryClient default retry', async () => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: 1, retryDelay: 0 } },
		});
		const { items, state } = setup(
			failOnce(new Error('flaky')),
			{ retryDelay: undefined },
			client,
		);
		await items._sync.loadSubset({});
		expect(state.attempts).toBe(2);
	});

	it('stops retrying once the subset unloads', async () => {
		const { items, state } = setup(
			async () => {
				throw new CallTerminatedError();
			},
			{ retry: 5, retryDelay: 20 },
		);
		const subset = {};
		const loading = Promise.resolve(items._sync.loadSubset(subset));
		await tick();
		expect(state.attempts).toBe(1);

		items._sync.unloadSubset(subset);
		await loading;
		await tick(60);
		expect(state.attempts).toBe(1);
		expect(items.size).toBe(0);
	});

	it('runs a fresh SELECT for each sync instead of sharing one', async () => {
		const pending: Array<(rows: unknown) => void> = [];
		const { items, state } = setup(
			() => new Promise((resolve) => pending.push(resolve)),
		);
		const first = Promise.resolve(items._sync.loadSubset({}));
		await tick();
		const second = Promise.resolve(
			items._sync.loadSubset({ refetch: true }),
		);
		await tick();

		expect(state.attempts).toBe(2);
		for (const resolve of pending) resolve([[row()]]);
		await Promise.all([first, second]);
		expect(items.has('item:a')).toBe(true);
	});

	it('leaves no subset queries in the QueryClient cache', async () => {
		const { items, queryClient } = setup(async () => [[row()]]);
		await items._sync.loadSubset({});
		await tick();
		const keys = queryClient
			.getQueryCache()
			.getAll()
			.map((query) => JSON.stringify(query.queryKey));
		expect(keys.filter((key) => key.includes('surreal-subset'))).toEqual(
			[],
		);
	});

	it('retries the CRDT on-demand load path', async () => {
		const { items, state } = setup(failOnce(new CallTerminatedError()), {
			crdt: { enabled: true, profile: 'json', updatesTable: 'item_update' },
		});
		await items._sync.loadSubset({});
		expect(state.attempts).toBeGreaterThanOrEqual(2);
	});
});
