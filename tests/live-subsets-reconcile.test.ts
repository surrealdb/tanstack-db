import { describe, expect, it } from 'bun:test';
import { createCollection, createLiveQueryCollection, eq } from '@tanstack/db';
import { QueryClient } from '@tanstack/query-core';
import { RecordId } from 'surrealdb';

import { surrealCollectionOptions } from '../src/index';

type Item = { id: RecordId<'item'>; group: string; rank: number };

const item = (key: string, group: string, rank: number): Item => ({
	id: new RecordId('item', key),
	group,
	rank,
});

const setup = (server: Item[], cached: Item[]) => {
	const db = {
		isFeatureSupported: () => false,
		query: async (sql: string, params: Record<string, unknown>) => {
			let rows = server;
			if (sql.includes('group =')) {
				rows = rows.filter((row) => row.group === params.p0);
			}
			if (sql.includes('ORDER BY rank ASC')) {
				rows = [...rows].sort((a, b) => a.rank - b.rank);
			}
			const limit = Object.values(params).find(
				(value) => typeof value === 'number',
			) as number | undefined;
			return [limit === undefined ? rows : rows.slice(0, limit)];
		},
	};
	const items = createCollection(
		surrealCollectionOptions<Item>({
			db: db as never,
			table: { name: 'item' },
			queryClient: new QueryClient(),
			queryKey: ['item', crypto.randomUUID()],
			syncMode: 'on-demand',
		}),
	);
	items.startSyncImmediate();
	for (const row of cached) {
		items._state.syncedData.set(row.id.toString(), row);
	}
	return items;
};

const keys = (items: ReturnType<typeof setup>) => [...items.keys()].sort();

describe('on-demand LIVE startup', () => {
	it('opens LIVE after a connection that was still pending', async () => {
		let connected = false;
		let finishConnecting = () => {};
		let opened = 0;
		const db = {
			ready: new Promise<void>((resolve) => {
				finishConnecting = () => {
					connected = true;
					resolve();
				};
			}),
			isFeatureSupported: () => connected,
			query: async () => [[item('keep', 'a', 1)]],
			live: () => {
				const live = { subscribe: () => {}, kill: async () => {} };
				opened += 1;
				return {
					where: async () => live,
					then: (resolve: (value: typeof live) => unknown) =>
						Promise.resolve(live).then(resolve),
				};
			},
		};
		const items = createCollection(
			surrealCollectionOptions<Item>({
				db: db as never,
				table: { name: 'item' },
				queryClient: new QueryClient(),
				queryKey: ['item', crypto.randomUUID()],
				syncMode: 'on-demand',
			}),
		);
		const query = createLiveQueryCollection((q) =>
			q.from({ item: items }).where(({ item }) => eq(item.group, 'a')),
		);
		const loading = query.preload();
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(opened).toBe(0);

		finishConnecting();
		await loading;
		expect(opened).toBe(1);
	});
});

describe('on-demand LIVE after session renewal', () => {
	it('reopens LIVE and keeps cached rows through a sign-out gap', async () => {
		const listeners = new Map<string, (payload?: unknown) => void>();
		let opened = 0;
		let rows = [item('keep', 'a', 1)];
		const db = {
			subscribe: (event: string, next: (payload?: unknown) => void) => {
				listeners.set(event, next);
				return () => listeners.delete(event);
			},
			isFeatureSupported: () => true,
			query: async () => [rows],
			live: () => {
				const live = { subscribe: () => {}, kill: async () => {} };
				opened += 1;
				return {
					where: async () => live,
					then: (resolve: (value: typeof live) => unknown) =>
						Promise.resolve(live).then(resolve),
				};
			},
		};
		const items = createCollection(
			surrealCollectionOptions<Item>({
				db: db as never,
				table: { name: 'item' },
				queryClient: new QueryClient(),
				queryKey: ['item', crypto.randomUUID()],
				syncMode: 'on-demand',
			}),
		);
		const query = createLiveQueryCollection((q) =>
			q.from({ item: items }).where(({ item }) => eq(item.group, 'a')),
		);
		await query.preload();
		expect(opened).toBe(1);

		listeners.get('auth')?.(null);
		expect(opened).toBe(1);
		rows = [item('keep', 'a', 1), item('new', 'a', 2)];
		listeners.get('auth')?.({ access: 'renewed' });
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(opened).toBe(2);
		expect(items.has('item:keep')).toBe(true);
		expect(items.has('item:new')).toBe(true);
	});

	it('reopens LIVE when the access token is replaced in place', async () => {
		const listeners = new Map<string, (payload?: unknown) => void>();
		let opened = 0;
		const db = {
			subscribe: (event: string, next: (payload?: unknown) => void) => {
				listeners.set(event, next);
				return () => listeners.delete(event);
			},
			isFeatureSupported: () => true,
			query: async () => [[item('keep', 'a', 1)]],
			live: () => {
				const live = { subscribe: () => {}, kill: async () => {} };
				opened += 1;
				return {
					where: async () => live,
					then: (resolve: (value: typeof live) => unknown) =>
						Promise.resolve(live).then(resolve),
				};
			},
		};
		const items = createCollection(
			surrealCollectionOptions<Item>({
				db: db as never,
				table: { name: 'item' },
				queryClient: new QueryClient(),
				queryKey: ['item', crypto.randomUUID()],
				syncMode: 'on-demand',
			}),
		);
		const query = createLiveQueryCollection((q) =>
			q.from({ item: items }).where(({ item }) => eq(item.group, 'a')),
		);
		await query.preload();
		listeners.get('auth')?.({ access: 'first' });
		await new Promise((resolve) => setTimeout(resolve, 10));
		const afterFirstToken = opened;

		listeners.get('auth')?.({ access: 'first' });
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(opened).toBe(afterFirstToken);

		listeners.get('auth')?.({ access: 'second' });
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(opened).toBe(afterFirstToken + 1);
		expect(items.has('item:keep')).toBe(true);
	});

	const startupRace = () => {
		const listeners = new Map<string, (payload?: unknown) => void>();
		let finishConnecting = () => {};
		const selects: Array<{
			resolve: (rows: Item[][]) => void;
			reject: (error: unknown) => void;
		}> = [];
		const db = {
			ready: new Promise<void>((resolve) => {
				finishConnecting = resolve;
			}),
			subscribe: (event: string, next: (payload?: unknown) => void) => {
				listeners.set(event, next);
				return () => listeners.delete(event);
			},
			isFeatureSupported: () => true,
			query: () =>
				new Promise<Item[][]>((resolve, reject) => {
					selects.push({ resolve, reject });
				}),
			live: () => {
				const live = { subscribe: () => {}, kill: async () => {} };
				return {
					where: async () => live,
					then: (resolve: (value: typeof live) => unknown) =>
						Promise.resolve(live).then(resolve),
				};
			},
		};
		const items = createCollection(
			surrealCollectionOptions<Item>({
				db: db as never,
				table: { name: 'item' },
				queryClient: new QueryClient(),
				queryKey: ['item', crypto.randomUUID()],
				syncMode: 'on-demand',
			}),
		);
		const query = createLiveQueryCollection((q) =>
			q.from({ item: items }).where(({ item }) => eq(item.group, 'a')),
		);
		let settled = false;
		const loading = query.preload().finally(() => {
			settled = true;
		});
		void loading.catch(() => undefined);
		return {
			listeners,
			selects,
			query,
			loading,
			isSettled: () => settled,
			connect: () => finishConnecting(),
		};
	};
	const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

	it('keeps preload pending when the first token arrives during startup', async () => {
		const race = startupRace();
		await tick();
		race.listeners.get('auth')?.({ access: 'first' });
		race.connect();
		await tick();

		expect(race.isSettled()).toBe(false);
		expect(race.query.status).not.toBe('ready');

		for (const select of race.selects) {
			select.resolve([[item('keep', 'a', 1)]]);
		}
		await race.loading;
		expect(race.query.toArray.map((row) => row.id.toString())).toEqual([
			'item:keep',
		]);
	});

	it('rejects a superseded preload when its replacement fails', async () => {
		const race = startupRace();
		await tick();
		race.listeners.get('auth')?.({ access: 'first' });
		race.connect();
		await tick();

		expect(race.isSettled()).toBe(false);
		for (const select of race.selects) select.reject(new Error('denied'));
		await tick();
		expect(race.isSettled()).toBe(true);
		expect(race.query.status).not.toBe('ready');
		await race.loading.catch(() => undefined);
	});
});

describe('on-demand snapshot reconciliation', () => {
	it('removes a cached row the server no longer returns', async () => {
		const keep = item('keep', 'a', 1);
		const items = setup([keep], [keep, item('ghost', 'a', 2)]);
		const query = createLiveQueryCollection((q) =>
			q.from({ item: items }).where(({ item }) => eq(item.group, 'a')),
		);
		await query.preload();

		expect(keys(items)).toEqual(['item:keep']);
		expect(query.toArray.map((row) => row.id.toString())).toEqual([
			'item:keep',
		]);
	});

	it('keeps cached rows outside the loaded filter', async () => {
		const keep = item('keep', 'a', 1);
		const other = item('other', 'b', 2);
		const items = setup([keep, other], [keep, other]);
		const query = createLiveQueryCollection((q) =>
			q.from({ item: items }).where(({ item }) => eq(item.group, 'a')),
		);
		await query.preload();

		expect(keys(items)).toEqual(['item:keep', 'item:other']);
	});

	it('only removes rows inside a full limited window', async () => {
		const first = item('first', 'a', 1);
		const second = item('second', 'a', 3);
		const beyond = item('beyond', 'a', 9);
		const ghost = item('ghost', 'a', 2);
		const items = setup(
			[first, second, beyond],
			[first, second, beyond, ghost],
		);
		const query = createLiveQueryCollection((q) =>
			q
				.from({ item: items })
				.orderBy(({ item }) => item.rank, 'asc')
				.limit(2),
		);
		await query.preload();

		expect(items.has('item:ghost')).toBe(false);
		expect(items.has('item:beyond')).toBe(true);
	});
});
