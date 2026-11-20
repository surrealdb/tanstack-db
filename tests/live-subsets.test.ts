import { describe, expect, it } from 'bun:test';
import { QueryClient } from '@tanstack/query-core';
import { type Expr, RecordId } from 'surrealdb';

import { toRecordIdString } from '../src/id';
import { surrealCollectionOptions } from '../src/index';
import {
	buildLiveCondition,
	buildSubsetQuery,
	windowBoundaryOf,
} from '../src/table';

const ref = (field: string) => ({ type: 'ref', path: [field] }) as const;
const val = (value: unknown) => ({ type: 'val', value }) as const;
const fn = (name: string, ...args: unknown[]) =>
	({ type: 'func', name, args }) as never;
const order = (field: string, direction: 'asc' | 'desc' = 'asc') =>
	({
		expression: ref(field),
		compareOptions: { direction, nulls: 'first' },
	}) as never;

const compile = (condition: Expr | undefined) => {
	const params: unknown[] = [];
	const sql = condition?.toSQL({
		def: (value) => {
			params.push(value);
			return `$v${params.length - 1}`;
		},
	});
	return { sql, params };
};

const table = { name: 'item' };

describe('subset queries', () => {
	it('sorts limited subsets by id when no order is given', () => {
		const { sql } = buildSubsetQuery(table, { limit: 2 });
		expect(sql).toBe(
			'SELECT * FROM type::table($table) ORDER BY id ASC LIMIT $p0;',
		);
	});

	it('adds id as the last tiebreaker of an ordered subset', () => {
		const { sql } = buildSubsetQuery(table, {
			orderBy: [order('name', 'desc')],
			limit: 10,
		});
		expect(sql).toContain('ORDER BY name DESC, id ASC LIMIT');
	});

	it('does not repeat id when the subset already orders by it', () => {
		const { sql } = buildSubsetQuery(table, {
			orderBy: [order('id', 'desc')],
			limit: 10,
		});
		expect(sql).toContain('ORDER BY id DESC LIMIT');
	});

	it('leaves unordered, unlimited subsets unsorted', () => {
		const { sql } = buildSubsetQuery(table, {
			where: fn('eq', ref('category'), val('books')),
		});
		expect(sql).not.toContain('ORDER BY');
	});
});

describe('live conditions', () => {
	it('subscribes to the whole table when a subset has no filter or window', () => {
		expect(buildLiveCondition(table, {})).toBeUndefined();
	});

	it('matches rows that match now or matched before the change', () => {
		const { sql, params } = compile(
			buildLiveCondition(table, {
				where: fn('eq', ref('category'), val('books')),
			}),
		);
		expect(sql).toBe(
			'((category = $v0)) OR ($before IS NOT NONE AND ($before.category = $v1))',
		);
		expect(params).toEqual(['books', 'books']);
	});

	it('bounds an ascending window at its last sort value', () => {
		const { sql, params } = compile(
			buildLiveCondition(table, { limit: 2 }, {
				field: ['name'],
				direction: 'asc',
				value: 'b',
			}),
		);
		expect(sql).toBe(
			'((name <= $v0 OR name IS NONE OR name IS NULL)) OR ($before IS NOT NONE AND ($before.name <= $v1 OR $before.name IS NONE OR $before.name IS NULL))',
		);
		expect(params).toEqual(['b', 'b']);
	});

	it('bounds a descending window from below', () => {
		const { sql } = compile(
			buildLiveCondition(table, { limit: 2 }, {
				field: ['score'],
				direction: 'desc',
				value: 10,
			}),
		);
		expect(sql).toContain('(score >= $v0');
	});

	it('only sets a window once the subset filled its limit', () => {
		const subset = { orderBy: [order('name')], limit: 2 };
		expect(windowBoundaryOf(table, subset, [{ name: 'a' }])).toBeUndefined();
		expect(
			windowBoundaryOf(table, subset, [{ name: 'a' }, { name: 'b' }]),
		).toEqual({ field: ['name'], direction: 'asc', value: 'b' });
	});

	it('windows a limited subset by id when no order is given', () => {
		const last = new RecordId('item', 'b');
		expect(
			windowBoundaryOf(table, { limit: 1 }, [{ id: last }]),
		).toEqual({ field: ['id'], direction: 'asc', value: last });
	});
});

type FakeLive = {
	condition?: Expr;
	killed: boolean;
	emit: (message: { action: string; value: Record<string, unknown> }) => void;
	subscribe: (handler: (message: unknown) => void) => () => void;
	kill: () => Promise<void>;
};

const createFakeDb = (rows: Array<Record<string, unknown>>) => {
	const lives: FakeLive[] = [];
	const listeners = new Map<string, Set<() => void>>();
	let queries = 0;
	let gate: Promise<void> = Promise.resolve();

	const openLive = (condition?: Expr): FakeLive => {
		const handlers: Array<(message: unknown) => void> = [];
		const live: FakeLive = {
			condition,
			killed: false,
			emit: (message) => {
				for (const handler of handlers) handler(message);
			},
			subscribe: (handler) => {
				handlers.push(handler);
				return () => {};
			},
			kill: async () => {
				live.killed = true;
			},
		};
		lives.push(live);
		return live;
	};

	const db = {
		isFeatureSupported: () => true,
		query: async () => {
			queries += 1;
			await gate;
			return [rows.map((row) => ({ ...row }))];
		},
		live: () => ({
			then: (
				resolve: (live: FakeLive) => unknown,
				reject: (error: unknown) => unknown,
			) => Promise.resolve(openLive()).then(resolve, reject),
			where: (condition: Expr) => Promise.resolve(openLive(condition)),
		}),
		subscribe: (event: string, listener: () => void) => {
			const set = listeners.get(event) ?? new Set();
			set.add(listener);
			listeners.set(event, set);
			return () => set.delete(listener);
		},
	};

	return {
		db,
		lives,
		queries: () => queries,
		hold: () => {
			let open = () => {};
			gate = new Promise<void>((resolve) => {
				open = resolve;
			});
			return () => open();
		},
		emitConnection: (event: string) => {
			for (const listener of listeners.get(event) ?? []) listener();
		},
	};
};

const startSync = (db: unknown) => {
	const rows = new Map<string, Record<string, unknown>>();
	let invalidations = 0;
	const options = surrealCollectionOptions<{ id: RecordId; name: string }>({
		db: db as never,
		table,
		queryClient: new QueryClient(),
		queryKey: ['item', Math.random()],
		syncMode: 'on-demand',
	});
	const result = options.sync?.sync({
		collection: { has: (key: string) => rows.has(key) },
		begin: () => {},
		write: (change: {
			type: string;
			key?: string;
			value?: Record<string, unknown>;
		}) => {
			if (change.type === 'delete') {
				rows.delete(change.key as string);
				return;
			}
			const value = change.value as Record<string, unknown>;
			rows.set(toRecordIdString(value.id as RecordId), value);
		},
		commit: () => true,
		markReady: () => {},
		truncate: () => {},
		invalidateLoadedSubsets: () => {
			invalidations += 1;
		},
	} as never) as unknown as {
		loadSubset: (subset: object) => Promise<void>;
		cleanup: () => void;
	};
	return { result, rows, invalidations: () => invalidations };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('live subsets', () => {
	it('keeps a change that arrives while the subset is loading', async () => {
		const fake = createFakeDb([{ id: new RecordId('item', 'a'), name: 'a' }]);
		const sync = startSync(fake.db);
		const open = fake.hold();

		const loading = sync.result.loadSubset({});
		await settle();
		fake.lives[0]?.emit({
			action: 'CREATE',
			value: { id: new RecordId('item', 'b'), name: 'b' },
		});
		open();
		await loading;
		await settle();

		expect([...sync.rows.keys()].sort()).toEqual(['item:a', 'item:b']);
		sync.result.cleanup();
	});

	it('swaps to a bounded live query once a limited subset fills', async () => {
		const fake = createFakeDb([
			{ id: new RecordId('item', 'a'), name: 'a' },
			{ id: new RecordId('item', 'b'), name: 'b' },
		]);
		const sync = startSync(fake.db);

		await sync.result.loadSubset({ orderBy: [order('name')], limit: 2 });

		expect(fake.lives).toHaveLength(2);
		expect(fake.lives[0]?.killed).toBe(true);
		expect(fake.lives[1]?.killed).toBe(false);
		expect(compile(fake.lives[1]?.condition).sql).toContain('name <= $v0');
		sync.result.cleanup();
	});

	it('refetches and resubscribes every subset after a reconnect', async () => {
		const fake = createFakeDb([{ id: new RecordId('item', 'a'), name: 'a' }]);
		const sync = startSync(fake.db);
		await sync.result.loadSubset({
			where: fn('eq', ref('name'), val('a')),
		});
		expect(fake.queries()).toBe(1);

		fake.emitConnection('connected');
		await settle();
		expect(fake.queries()).toBe(1);

		fake.emitConnection('reconnecting');
		fake.emitConnection('connected');
		await settle();

		expect(fake.queries()).toBe(2);
		expect(fake.lives).toHaveLength(2);
		expect(fake.lives[0]?.killed).toBe(true);
		expect(fake.lives[1]?.killed).toBe(false);
		expect(sync.invalidations()).toBe(1);
		sync.result.cleanup();
		expect(fake.lives[1]?.killed).toBe(true);
	});
});
