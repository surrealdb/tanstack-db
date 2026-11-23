import { describe, expect, it } from 'bun:test';
import { createCollection, createLiveQueryCollection } from '@tanstack/db';
import { QueryClient } from '@tanstack/query-core';
import { RecordId } from 'surrealdb';

import { toRecordKeyString } from '../src/id';
import { createLiveSubsets } from '../src/internal/live-subsets';
import { ActiveSubsetTracker } from '../src/internal/subset-tracker';
import { surrealCollectionOptions } from '../src/index';

type Item = { id: RecordId<'item'>; rank: number };
type Message = { action: string; value?: Record<string, unknown> };

const item = (key: string, rank = 1): Item => ({
	id: new RecordId('item', key),
	rank,
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

const deferred = <V = void>() => {
	let resolve!: (value: V) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<V>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
};

const fakeLive = () => {
	const opened: Array<{
		killed: boolean;
		emit: (message: Message) => void;
	}> = [];
	const live = () => {
		const record = {
			killed: false,
			emit: (_message: Message) => {},
		};
		opened.push(record);
		const subscription = {
			subscribe: (next: (message: Message) => void) => {
				record.emit = next;
			},
			kill: async () => {
				record.killed = true;
			},
		};
		return {
			where: async () => subscription,
			then: (resolve: (value: typeof subscription) => unknown) =>
				Promise.resolve(subscription).then(resolve),
		};
	};
	return { opened, live };
};

const harness = (initial: Item[]) => {
	const listeners = new Map<string, (payload?: unknown) => void>();
	const { opened, live } = fakeLive();
	const store = new Map<string, Item>();
	const tracker = new ActiveSubsetTracker();
	const state = {
		rows: initial,
		attempts: 0,
		failNext: false,
		decode: async (row: Record<string, unknown>) => row as Item,
	};
	const subsets = createLiveSubsets<Item>({
		db: {
			subscribe: (event: string, next: (payload?: unknown) => void) => {
				listeners.set(event, next);
				return () => listeners.delete(event);
			},
			isFeatureSupported: () => true,
			live,
		} as never,
		table: { name: 'item' } as never,
		tracker,
		loadRows: async () => {
			state.attempts += 1;
			if (state.failNext) {
				state.failNext = false;
				throw new Error('offline');
			}
			return state.rows;
		},
		decode: (row) => state.decode(row),
		writeRows: async (rows) => {
			for (const row of rows) store.set(toRecordKeyString(row.id), row);
		},
		evict: async (ids) => {
			for (const id of ids) store.delete(id);
		},
		syncedRows: () => store.values(),
		invalidate: () => {},
	});
	return { subsets, store, tracker, state, opened, listeners };
};

describe('live subset ownership', () => {
	it('keeps the shared LIVE query until every acquisition is released', async () => {
		const { subsets, store, opened } = harness([item('a')]);
		await subsets.load({});
		await subsets.load({ refetch: true });
		const current = opened.filter((live) => !live.killed);
		expect(current).toHaveLength(1);

		subsets.unload({ refetch: true });
		expect(current[0]?.killed).toBe(false);
		expect(store.has('a')).toBe(true);

		subsets.unload({});
		await tick();
		expect(current[0]?.killed).toBe(true);
		expect(store.has('a')).toBe(true);
	});

	it('keeps rows after unload and reconciles them on the next load', async () => {
		const { subsets, store, state, tracker } = harness([
			item('kept'),
			item('removed'),
		]);
		await subsets.load({});
		subsets.unload({});
		await tick();
		expect([...store.keys()].sort()).toEqual(['kept', 'removed']);
		expect(tracker.size).toBe(0);

		state.rows = [item('kept', 2)];
		await subsets.load({});
		expect([...store.keys()]).toEqual(['kept']);
		expect(store.get('kept')?.rank).toBe(2);
	});
});

describe('live subset unload during decode', () => {
	it('does not restore a snapshot that finishes decoding after unload', async () => {
		const { subsets, store, tracker, state } = harness([item('a')]);
		const gate = deferred();
		state.decode = async (row) => {
			await gate.promise;
			return row as Item;
		};
		const loading = subsets.load({});
		await tick();
		subsets.unload({});
		gate.resolve();
		await loading;
		await tick();

		expect(store.size).toBe(0);
		expect(tracker.size).toBe(0);
		expect(tracker.has('a')).toBe(false);
	});

	it('does not apply a LIVE row that finishes decoding after unload', async () => {
		const { subsets, store, tracker, state, opened } = harness([]);
		await subsets.load({});
		const gate = deferred();
		state.decode = async (row) => {
			await gate.promise;
			return row as Item;
		};
		opened[0]?.emit({ action: 'CREATE', value: item('late') });
		await tick();
		subsets.unload({});
		gate.resolve();
		await tick();

		expect(store.size).toBe(0);
		expect(tracker.has('late')).toBe(false);
	});
});

describe('live subset load failures', () => {
	it('retries after a failed load and keeps ownership counts', async () => {
		const { subsets, store, state, opened } = harness([item('a')]);
		state.failNext = true;
		await expect(subsets.load({})).rejects.toThrow('offline');

		await subsets.load({});
		expect(state.attempts).toBe(2);
		expect(store.has('a')).toBe(true);

		subsets.unload({});
		expect(store.has('a')).toBe(true);
		expect(opened.some((live) => !live.killed)).toBe(true);

		subsets.unload({});
		await tick();
		expect(store.has('a')).toBe(true);
		expect(opened.every((live) => live.killed)).toBe(true);
	});

	it('stops returning the old failure after resync recovers', async () => {
		const { subsets, store, state } = harness([item('a')]);
		state.failNext = true;
		await expect(subsets.load({})).rejects.toThrow('offline');

		await subsets.resync();
		expect(store.has('a')).toBe(true);

		await subsets.load({});
		expect(state.attempts).toBe(2);
	});

	it('stops returning the old failure after a reconnect recovers', async () => {
		const { subsets, store, state, listeners } = harness([item('a')]);
		state.failNext = true;
		await expect(subsets.load({})).rejects.toThrow('offline');

		listeners.get('disconnected')?.();
		listeners.get('connected')?.();
		await tick();
		expect(store.has('a')).toBe(true);

		await subsets.load({});
		expect(state.attempts).toBe(2);
	});
});

describe('live subset snapshots while signed out', () => {
	it('keeps tracked rows, then reconciles once authenticated', async () => {
		const { subsets, store, state, listeners } = harness([item('a')]);
		await subsets.load({});

		listeners.get('auth')?.(null);
		state.rows = [];
		await subsets.load({ refetch: true });
		expect(store.has('a')).toBe(true);

		listeners.get('auth')?.({ access: 'renewed' });
		await tick();
		expect(store.has('a')).toBe(false);
	});

	it('still serves rows readable without a session', async () => {
		const { subsets, store, state, listeners } = harness([]);
		listeners.get('auth')?.(null);
		state.rows = [item('public')];
		await subsets.load({});
		expect(store.has('public')).toBe(true);
	});
});

describe('LIVE changes during a pending optimistic delete', () => {
	const setup = async () => {
		const row = item('a');
		const { opened, live } = fakeLive();
		const removal = deferred();
		const errors: unknown[] = [];
		const items = createCollection(
			surrealCollectionOptions<Item>({
				db: {
					isFeatureSupported: () => true,
					query: async () => [[row]],
					live,
					delete: () => removal.promise,
				} as never,
				table: { name: 'item' },
				queryClient: new QueryClient(),
				queryKey: ['item', crypto.randomUUID()],
				syncMode: 'on-demand',
				onError: (error: unknown) => errors.push(error),
			}),
		);
		const query = createLiveQueryCollection((q) =>
			q.from({ item: items }),
		);
		await query.preload();
		const tx = items.delete('item:a');
		expect(items.has('item:a')).toBe(false);
		return { items, tx, removal, errors, emit: opened[0]?.emit };
	};

	it('keeps a remote update when the delete rolls back', async () => {
		const { items, tx, removal, errors, emit } = await setup();
		emit?.({ action: 'UPDATE', value: item('a', 2) });
		await tick();

		removal.reject(new Error('denied'));
		await tx.when('settled').catch(() => undefined);
		await tick();

		expect(errors).toEqual([]);
		expect(items.get('item:a')?.rank).toBe(2);
	});

	it('keeps a remote delete when the delete rolls back', async () => {
		const { items, tx, removal, errors, emit } = await setup();
		emit?.({ action: 'DELETE', value: item('a') });
		await tick();

		removal.reject(new Error('denied'));
		await tx.when('settled').catch(() => undefined);
		await tick();

		expect(errors).toEqual([]);
		expect(items.has('item:a')).toBe(false);
	});
});
