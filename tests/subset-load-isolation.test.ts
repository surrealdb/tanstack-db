import { describe, expect, it } from 'bun:test';
import { createRequire } from 'node:module';
import { createCollection } from '@tanstack/db';
import { QueryClient } from '@tanstack/query-core';
import { CallTerminatedError, RecordId, ServerError } from 'surrealdb';

import { surrealCollectionOptions } from '../src/index';

type Item = { id: RecordId; title: string };

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
const requireCjs = createRequire(import.meta.url);

const collectionFor = (
	db: unknown,
	options: Record<string, unknown> = {},
	queryClient = new QueryClient(),
) => {
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
	return items;
};

const crdt = {
	crdt: { enabled: true, profile: 'json', updatesTable: 'item_update' },
};

describe('subset loader query keys', () => {
	it('keeps concurrent loads from separate collections apart', async () => {
		const queryClient = new QueryClient();
		const queryKey = ['shared'];
		const pending: Array<() => void> = [];
		const dbFor = (table: string, state: { selects: number }) => ({
			isFeatureSupported: () => false,
			query: () => {
				state.selects += 1;
				return new Promise((resolve) => {
					pending.push(() =>
						resolve([[{ id: new RecordId(table, 'a'), title: table }]]),
					);
				});
			},
		});
		const first = { selects: 0 };
		const second = { selects: 0 };
		const one = collectionFor(
			dbFor('one', first),
			{ id: 'one', table: { name: 'one' }, queryKey },
			queryClient,
		);
		const two = collectionFor(
			dbFor('two', second),
			{ id: 'two', table: { name: 'two' }, queryKey },
			queryClient,
		);

		const loads = [
			Promise.resolve(one._sync.loadSubset({})),
			Promise.resolve(two._sync.loadSubset({})),
		];
		await tick();
		expect([first.selects, second.selects]).toEqual([1, 1]);
		for (const resolve of pending) resolve();
		await Promise.all(loads);

		expect(one.has('one:a')).toBe(true);
		expect(two.has('two:a')).toBe(true);
	});
});

describe('CRDT subset load retirement', () => {
	const failing = () => {
		const state = { attempts: 0 };
		const db = {
			isFeatureSupported: () => false,
			query: async () => {
				state.attempts += 1;
				throw new CallTerminatedError();
			},
		};
		return { state, db };
	};

	it('stops retrying when the subset unloads', async () => {
		const { state, db } = failing();
		const items = collectionFor(db, { ...crdt, retry: true, retryDelay: 5 });
		const subset = {};
		const loading = Promise.resolve(items._sync.loadSubset(subset));
		await tick(12);
		items._sync.unloadSubset(subset);
		await loading;
		const attempts = state.attempts;
		await tick(40);
		expect(state.attempts).toBe(attempts);
	});

	it('stops retrying when the collection cleans up', async () => {
		const { state, db } = failing();
		const items = collectionFor(db, { ...crdt, retry: true, retryDelay: 5 });
		const loading = Promise.resolve(items._sync.loadSubset({})).catch(
			() => undefined,
		);
		await tick(12);
		await items.cleanup();
		await loading;
		const attempts = state.attempts;
		await tick(40);
		expect(state.attempts).toBe(attempts);
	});

	it('stops retrying when the request signal aborts', async () => {
		const { state, db } = failing();
		const items = collectionFor(db, { ...crdt, retry: true, retryDelay: 5 });
		const controller = new AbortController();
		const loading = Promise.resolve(
			items._sync.loadSubset({ signal: controller.signal }),
		).catch(() => undefined);
		await tick(12);
		controller.abort();
		await loading;
		const attempts = state.attempts;
		await tick(40);
		expect(state.attempts).toBe(attempts);
	});

	it('does not hydrate or open LIVE after the subset unloads', async () => {
		let release = () => {};
		const state = { queries: 0, lives: 0 };
		const db = {
			isFeatureSupported: () => true,
			query: () => {
				state.queries += 1;
				return new Promise((resolve) => {
					release = () =>
						resolve([[{ id: new RecordId('item', 'a'), title: 'A' }]]);
				});
			},
			live: async () => {
				state.lives += 1;
				return { subscribe: () => {}, kill: async () => {} };
			},
		};
		const items = collectionFor(db, crdt);
		const subset = {};
		const loading = Promise.resolve(items._sync.loadSubset(subset));
		await tick();
		expect(state.queries).toBe(1);

		items._sync.unloadSubset(subset);
		release();
		await loading;
		await tick();

		expect(state.queries).toBe(1);
		expect(state.lives).toBe(0);
		expect(items.has('item:a')).toBe(false);
	});

	it('kills a LIVE query that opens after the subset unloads', async () => {
		let finishLive = (_live: unknown) => {};
		let killed = 0;
		const db = {
			isFeatureSupported: () => true,
			query: async (sql: string) =>
				sql.includes('WHERE doc') ? [[]] : [[]],
			live: () =>
				new Promise((resolve) => {
					finishLive = resolve;
				}),
		};
		const items = collectionFor(db, crdt);
		const subset = {};
		const loading = Promise.resolve(items._sync.loadSubset(subset));
		await tick();
		items._sync.unloadSubset(subset);
		finishLive({
			subscribe: () => {
				throw new Error('a retired load subscribed');
			},
			kill: async () => {
				killed += 1;
			},
		});
		await loading;
		expect(killed).toBe(1);
	});
});

describe('connection errors across SDK entry points', () => {
	const cjs = requireCjs('surrealdb') as {
		CallTerminatedError: new () => Error;
		ServerError: new (response: unknown) => Error;
	};
	const attemptsWith = async (error: Error) => {
		let attempts = 0;
		const db = {
			isFeatureSupported: () => false,
			query: async () => {
				attempts += 1;
				if (attempts === 1) throw error;
				return [[{ id: new RecordId('item', 'a'), title: 'A' }]];
			},
		};
		const items = collectionFor(db);
		await Promise.resolve(items._sync.loadSubset({})).catch(() => undefined);
		return attempts;
	};

	it('retries a connection error from the other entry point', async () => {
		const error = new cjs.CallTerminatedError();
		expect(error instanceof CallTerminatedError).toBe(false);
		expect(await attemptsWith(error)).toBe(2);
	});

	it('does not retry a server error from either entry point', async () => {
		const response = { kind: 'Internal', message: 'denied' };
		expect(await attemptsWith(new cjs.ServerError(response))).toBe(1);
		expect(await attemptsWith(new ServerError(response as never))).toBe(1);
	});

	it('does not retry an unbranded error with a connection name', async () => {
		const error = new Error('lookalike');
		error.name = 'CallTerminatedError';
		expect(await attemptsWith(error)).toBe(1);
	});
});
