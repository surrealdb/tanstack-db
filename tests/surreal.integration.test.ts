import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createCollection, createLiveQueryCollection, eq } from '@tanstack/db';
import { QueryClient } from '@tanstack/query-core';
import { Features, RecordId, Surreal, Table } from 'surrealdb';

import { toRecordIdString, toRecordKeyString } from '../src/id';
import { surrealCollectionOptions } from '../src/index';
import { manageTable } from '../src/table';

type IntegrationEnv = {
	url: string;
	namespace: string;
	database: string;
	username?: string;
	password?: string;
	token?: string;
	requireLive: boolean;
};

type SyncWrite = {
	type: 'insert' | 'update' | 'delete';
	value?: Record<string, unknown>;
	key?: string;
};

const cjsSurreal = require('surrealdb') as {
	RecordId: new (table: string, id: string) => unknown;
};
const CjsRecordId = cjsSurreal.RecordId;

const loadIntegrationEnv = (): IntegrationEnv | null => {
	const url = process.env.SURREAL_URL;
	if (!url) return null;

	const namespace = process.env.SURREAL_NAMESPACE ?? 'test';
	const database = process.env.SURREAL_DATABASE ?? 'test';
	const token = process.env.SURREAL_TOKEN;
	const username = process.env.SURREAL_USERNAME;
	const password = process.env.SURREAL_PASSWORD;
	const requireLive = process.env.SURREAL_REQUIRE_LIVE !== 'false';

	if (!token && !(username && password)) {
		throw new Error(
			'Real Surreal integration tests require either SURREAL_TOKEN or SURREAL_USERNAME + SURREAL_PASSWORD.',
		);
	}

	return {
		url,
		namespace,
		database,
		username,
		password,
		token,
		requireLive,
	};
};

const integrationEnv =
	process.env.SURREAL_RUN_INTEGRATION === 'true'
		? loadIntegrationEnv()
		: null;

const sleep = (ms: number) =>
	new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});

const waitFor = async (
	check: () => boolean,
	message: string,
	timeoutMs = 8_000,
) => {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		if (check()) return;
		await sleep(25);
	}
	throw new Error(`Timed out waiting for: ${message}`);
};

const cleanupSyncResult = (result: unknown) => {
	if (typeof result === 'function') {
		result();
		return;
	}

	if (
		result &&
		typeof result === 'object' &&
		'cleanup' in result &&
		typeof (result as { cleanup?: unknown }).cleanup === 'function'
	) {
		(result as { cleanup: () => void }).cleanup();
	}
};

const createTableName = (prefix: string) =>
	`${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

const assertSafeIdentifier = (value: string): string => {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
		throw new Error(`Unsafe table identifier: ${value}`);
	}
	return value;
};

const ensureTableSchema = async (db: Surreal, tableName: string) => {
	const safe = assertSafeIdentifier(tableName);
	await db.query(`DEFINE TABLE ${safe} SCHEMAFULL;`);
	await db.query(`DEFINE FIELD name ON ${safe} TYPE option<string>;`);
	await db.query(`DEFINE FIELD category ON ${safe} TYPE option<string>;`);
	await db.query(`DEFINE FIELD title ON ${safe} TYPE option<string>;`);
	await db.query(`DEFINE FIELD owner ON ${safe} TYPE option<record<account>>;`);
};

const dropTable = async (db: Surreal, tableName: string) => {
	const safe = assertSafeIdentifier(tableName);
	await db.query(`REMOVE TABLE ${safe};`);
};

const requireLiveQueries = (db: Surreal) => {
	if (
		integrationEnv?.requireLive &&
		!db.isFeatureSupported(Features.LiveQueries)
	) {
		throw new Error(
			'LiveQueries are not supported by this Surreal connection. Use a ws:// or wss:// SURREAL_URL, or set SURREAL_REQUIRE_LIVE=false.',
		);
	}
};

const ref = (field: string) => ({ type: 'ref', path: [field] }) as const;
const val = (value: unknown) => ({ type: 'val', value }) as const;
const fn = (name: string, ...args: unknown[]) =>
	({ type: 'func', name, args }) as never;
const asc = (field: string) =>
	({
		expression: ref(field),
		compareOptions: { direction: 'asc', nulls: 'first' },
	}) as never;

type HeldRow = Record<string, unknown> & { id: RecordId | string };
type SubsetSync = {
	loadSubset: (subset: object) => Promise<void>;
	unloadSubset: (subset: object) => void;
};

const startOnDemandSync = (db: Surreal, tableName: string, label: string) => {
	const options = surrealCollectionOptions<HeldRow>({
		db,
		table: { name: tableName },
		queryClient: new QueryClient(),
		queryKey: [tableName, label],
		syncMode: 'on-demand',
	});
	const rows = new Map<string, Record<string, unknown>>();
	const writes: SyncWrite[] = [];
	const result = options.sync?.sync({
		collection: { has: (key: string) => rows.has(key) },
		begin: () => {},
		write: (change: unknown) => {
			const write = change as SyncWrite;
			writes.push(write);
			if (write.type === 'delete') {
				rows.delete(
					write.key ??
						toRecordIdString(write.value?.id as RecordId | string),
				);
				return;
			}
			const value = write.value as Record<string, unknown>;
			rows.set(toRecordIdString(value.id as RecordId | string), value);
		},
		commit: () => true,
		markReady: () => {},
		truncate: () => {},
		invalidateLoadedSubsets: () => {},
	} as never);
	const subsets = result as unknown as SubsetSync;

	return {
		writes,
		loadSubset: (subset: object) => subsets.loadSubset(subset),
		unloadSubset: (subset: object) => subsets.unloadSubset(subset),
		has: (id: string) => rows.has(`${tableName}:${id}`),
		row: (id: string) => rows.get(`${tableName}:${id}`),
		keys: () => [...rows.keys()].sort(),
		cleanup: () => cleanupSyncResult(result),
	};
};

if (!integrationEnv) {
	describe('real surreal integration', () => {
		it.skip('requires SURREAL_URL and auth env vars', () => {});
	});
} else {
	describe('real surreal integration', () => {
	let db: Surreal;
	const createdTables = new Set<string>();

	beforeAll(async () => {
		const env = integrationEnv;
		db = new Surreal();
		await db.connect(env.url);

		if (env.token) {
			await db.authenticate(env.token);
		} else {
			await db.signin({
				username: env.username as string,
				password: env.password as string,
			});
		}

		await db.use({
			namespace: env.namespace,
			database: env.database,
		});
	});

	afterAll(async () => {
		for (const tableName of createdTables) {
			await dropTable(db, tableName).catch(() => undefined);
		}
		await db.close().catch(() => undefined);
	});

	it('runs CRUD against a real table via manageTable', async () => {
		const tableName = createTableName('it_crud');
		createdTables.add(tableName);
		await ensureTableSchema(db, tableName);
		await db.query('DELETE type::table($table);', { table: tableName });

		type Item = { id: string | RecordId; name: string; category?: string };
		const table = manageTable<Item>(db as never, { name: tableName });

		const createdAuto = await table.create({
			name: 'desk',
			category: 'office',
		});
		const createdFixed = await table.create({
			id: 'fixed-1',
			name: 'chair',
			category: 'office',
		});

		expect(createdAuto).toBeDefined();
		expect(createdFixed).toBeDefined();
		expect(toRecordKeyString((createdFixed as Item).id)).toBe('fixed-1');

		const list = await table.listAll();
		expect(list.length).toBe(2);

		const autoRid = new RecordId(
			tableName,
			toRecordKeyString((createdAuto as Item).id),
		);
		await table.update(autoRid, { name: 'desk-v2' });

		const updated = await db.select(autoRid);
		const updatedRow = Array.isArray(updated) ? updated[0] : updated;
		expect((updatedRow as { name?: string } | undefined)?.name).toBe('desk-v2');

		await table.remove(new RecordId(tableName, 'fixed-1'));
		const remaining = await table.listAll();
		expect(remaining.length).toBe(1);
	});

	it('hydrates and replicates live updates in eager mode', async () => {
		const env = integrationEnv;
		if (env.requireLive && !db.isFeatureSupported(Features.LiveQueries)) {
			throw new Error(
				'LiveQueries are not supported by this Surreal connection. Use a ws:// or wss:// SURREAL_URL, or set SURREAL_REQUIRE_LIVE=false.',
			);
		}

		const tableName = createTableName('it_eager');
		createdTables.add(tableName);
		const seedId = new RecordId(tableName, 'seed-1');

		await ensureTableSchema(db, tableName);
		await db.query('DELETE type::table($table);', { table: tableName });
		await db.insert(new Table(tableName), {
			id: seedId,
			title: 'Seed',
		});

		type Note = { id: string | RecordId; title: string };
		const options = surrealCollectionOptions<Note>({
			db,
			table: { name: tableName },
			queryClient: new QueryClient(),
			queryKey: [tableName, 'eager'],
			syncMode: 'eager',
		});

		let ready = 0;
		const writes: SyncWrite[] = [];
		const syncResult = options.sync?.sync({
			collection: {},
			begin: () => {},
			write: (change: unknown) => writes.push(change as SyncWrite),
			commit: () => {},
			markReady: () => {
				ready += 1;
			},
			truncate: () => {},
		} as never);

		await waitFor(
			() =>
				ready === 1 &&
				writes.some(
					(change) =>
						(change.value as { title?: string } | undefined)?.title === 'Seed',
				),
			'eager initial hydration to complete',
		);

		await db.insert(new Table(tableName), {
			id: new RecordId(tableName, 'seed-2'),
			title: 'From Live',
		});
		await waitFor(
			() =>
				writes.some(
					(change) =>
						(change.value as { title?: string } | undefined)?.title ===
						'From Live',
				),
			'live CREATE event to be replicated',
		);

		await db.update(seedId).merge({ title: 'Seed Updated' });
		await waitFor(
			() =>
				writes.some(
					(change) =>
						(change.value as { title?: string } | undefined)?.title ===
						'Seed Updated',
				),
			'live UPDATE event to be replicated',
		);

		cleanupSyncResult(syncResult);
	});

	it('streams rows entering, changing and leaving a filtered on-demand subset', async () => {
		requireLiveQueries(db);
		const tableName = createTableName('it_subset_filter');
		createdTables.add(tableName);
		await ensureTableSchema(db, tableName);
		const rid = (id: string) => new RecordId(tableName, id);
		await db.insert(new Table(tableName), [
			{ id: rid('one'), title: 'One', category: 'books' },
			{ id: rid('two'), title: 'Two', category: 'games' },
		]);

		const sync = startOnDemandSync(db, tableName, 'filter');
		await sync.loadSubset({ where: fn('eq', ref('category'), val('books')) });
		expect(sync.keys()).toEqual([`${tableName}:one`]);

		await db.insert(new Table(tableName), {
			id: rid('three'),
			title: 'Three',
			category: 'games',
		});
		await sleep(400);
		expect(sync.has('three')).toBe(false);

		await db.insert(new Table(tableName), {
			id: rid('four'),
			title: 'Four',
			category: 'books',
		});
		await waitFor(() => sync.has('four'), 'a new matching row to stream in');

		await db.update(rid('two')).merge({ category: 'books' });
		await waitFor(() => sync.has('two'), 'a row entering the filter');

		await db.update(rid('one')).merge({ category: 'games' });
		await waitFor(() => !sync.has('one'), 'a row leaving the filter');

		await db.delete(rid('four'));
		await waitFor(() => !sync.has('four'), 'a deleted row to go');

		sync.cleanup();
	});

	it('streams only changes inside the window of an ordered, limited subset', async () => {
		requireLiveQueries(db);
		const tableName = createTableName('it_subset_window');
		createdTables.add(tableName);
		await ensureTableSchema(db, tableName);
		const rid = (id: string) => new RecordId(tableName, id);
		await db.insert(
			new Table(tableName),
			['a', 'b', 'c', 'd', 'e'].map((name) => ({
				id: rid(name),
				name,
				title: name.toUpperCase(),
			})),
		);

		const sync = startOnDemandSync(db, tableName, 'window');
		await sync.loadSubset({ orderBy: [asc('name')], limit: 2 });
		expect(sync.keys()).toEqual([`${tableName}:a`, `${tableName}:b`]);

		const before = sync.writes.length;
		await db.update(rid('e')).merge({ title: 'E2' });
		await db.insert(new Table(tableName), { id: rid('z'), name: 'z' });
		await sleep(400);
		expect(sync.writes.length).toBe(before);

		await db.insert(new Table(tableName), { id: rid('aa'), name: 'aa' });
		await waitFor(() => sync.has('aa'), 'a row sorting into the window');

		await db.update(rid('a')).merge({ title: 'A2' });
		await waitFor(
			() => sync.row('a')?.title === 'A2',
			'an update inside the window',
		);

		await db.delete(rid('b'));
		await waitFor(() => !sync.has('b'), 'a delete inside the window');

		sync.cleanup();
	});

	it('sorts a limited subset by id when no order is given', async () => {
		const tableName = createTableName('it_subset_default_sort');
		createdTables.add(tableName);
		await ensureTableSchema(db, tableName);
		await db.insert(
			new Table(tableName),
			['d', 'b', 'e', 'a', 'c'].map((name) => ({
				id: new RecordId(tableName, name),
				name,
			})),
		);

		const table = manageTable<{ id: RecordId; name: string }>(db, {
			name: tableName,
		});
		const first = await table.loadSubset({ limit: 2 });
		const second = await table.loadSubset({ limit: 2, offset: 2 });
		expect(
			[...first, ...second].map((row) => toRecordKeyString(row.id)),
		).toEqual(['a', 'b', 'c', 'd']);
	});

	it('keeps rows matched by a RecordId filter when their other fields change', async () => {
		requireLiveQueries(db);
		const tableName = createTableName('it_subset_owner');
		createdTables.add(tableName);
		await ensureTableSchema(db, tableName);
		const rid = (id: string) => new RecordId(tableName, id);
		const owner = new RecordId('account', 'subset-owner');
		await db.insert(new Table(tableName), [
			{ id: rid('mine'), title: 'Mine', owner },
			{
				id: rid('theirs'),
				title: 'Theirs',
				owner: new RecordId('account', 'someone-else'),
			},
		]);

		const sync = startOnDemandSync(db, tableName, 'owner');
		await sync.loadSubset({
			where: fn('eq', ref('owner'), val(new RecordId('account', 'subset-owner'))),
		});
		expect(sync.keys()).toEqual([`${tableName}:mine`]);

		await db.update(rid('mine')).merge({ title: 'Mine v2' });
		await waitFor(
			() => sync.row('mine')?.title === 'Mine v2',
			'an update to an owned row',
		);
		expect(sync.has('mine')).toBe(true);

		sync.cleanup();
	});

	it('evicts rows and stops streaming when a subset unloads', async () => {
		requireLiveQueries(db);
		const tableName = createTableName('it_subset_unload');
		createdTables.add(tableName);
		await ensureTableSchema(db, tableName);
		const rid = (id: string) => new RecordId(tableName, id);
		await db.insert(new Table(tableName), [
			{ id: rid('one'), title: 'One', category: 'books' },
			{ id: rid('two'), title: 'Two', category: 'games' },
		]);

		const sync = startOnDemandSync(db, tableName, 'unload');
		const books = { where: fn('eq', ref('category'), val('books')) };
		const games = { where: fn('eq', ref('category'), val('games')) };
		await sync.loadSubset(books);
		await sync.loadSubset(games);
		expect(sync.keys().sort()).toEqual([
			`${tableName}:one`,
			`${tableName}:two`,
		]);

		sync.unloadSubset(books);
		await waitFor(() => !sync.has('one'), 'rows only the unloaded subset held');
		expect(sync.has('two')).toBe(true);

		await db.insert(new Table(tableName), {
			id: rid('three'),
			title: 'Three',
			category: 'books',
		});
		await sleep(400);
		expect(sync.has('three')).toBe(false);

		sync.cleanup();
	});

	it('keeps an ordered live query window full as rows change', async () => {
		requireLiveQueries(db);
		const tableName = createTableName('it_window_e2e');
		createdTables.add(tableName);
		await ensureTableSchema(db, tableName);
		const rid = (id: string) => new RecordId(tableName, id);
		await db.insert(
			new Table(tableName),
			['b', 'c', 'd', 'e'].map((name) => ({ id: rid(name), name })),
		);

		type Item = { id: RecordId; name: string };
		const items = createCollection(
			surrealCollectionOptions<Item>({
				db,
				table: { name: tableName },
				queryClient: new QueryClient(),
				queryKey: [tableName, 'window-e2e'],
				syncMode: 'on-demand',
			}),
		);
		const topTwo = createLiveQueryCollection((query) =>
			query
				.from({ item: items })
				.orderBy(({ item }) => item.name, 'asc')
				.limit(2),
		);
		const names = () => topTwo.toArray.map((row) => row.name);

		await topTwo.preload();
		expect(names()).toEqual(['b', 'c']);

		await db.insert(new Table(tableName), { id: rid('a'), name: 'a' });
		await waitFor(
			() => names().join() === 'a,b',
			'a new first row to enter the window',
		);

		await db.delete(rid('a'));
		await db.delete(rid('b'));
		await waitFor(
			() => names().join() === 'c,d',
			'the window to refill after deletes',
		);

		await topTwo.cleanup();
		await items.cleanup();
	});

	it('filters rows by RecordId in WHERE (native + cross-runtime)', async () => {
		const tableName = createTableName('it_where_recordid');
		createdTables.add(tableName);
		await ensureTableSchema(db, tableName);
		await db.query('DELETE type::table($table);', { table: tableName });

		const ownerA = new RecordId('account', 'user-a');
		const ownerB = new RecordId('account', 'user-b');
		await db.insert(new Table(tableName), [
			{
				id: new RecordId(tableName, 'r1'),
				title: 'One',
				owner: ownerA,
			},
			{
				id: new RecordId(tableName, 'r2'),
				title: 'Two',
				owner: ownerB,
			},
		]);

		type Item = { id: string | RecordId; title: string; owner: RecordId };
		const table = manageTable<Item>(db as never, { name: tableName });
		const ref = (field: string) => ({ type: 'ref', path: [field] }) as const;
		const val = (value: unknown) => ({ type: 'val', value }) as const;
		const eqExpr = (field: string, value: unknown) =>
			({ type: 'func', name: 'eq', args: [ref(field), val(value)] }) as const;

		const nativeRows = await table.loadSubset({
			where: eqExpr('owner', ownerA) as never,
		});
		expect(nativeRows.length).toBe(1);
		expect(toRecordKeyString(nativeRows[0]?.id as string | RecordId)).toBe('r1');

		const foreignOwnerA = new CjsRecordId('account', 'user-a');
		const crossRuntimeRows = await table.loadSubset({
			where: eqExpr('owner', foreignOwnerA) as never,
		});
		expect(crossRuntimeRows.length).toBe(1);
		expect(toRecordKeyString(crossRuntimeRows[0]?.id as string | RecordId)).toBe(
			'r1',
		);
	});

	it('query-driven on-demand WHERE matches RecordId owners against real Surreal', async () => {
		const tableName = createTableName('it_query_where_recordid');
		createdTables.add(tableName);
		await ensureTableSchema(db, tableName);
		await db.query('DELETE type::table($table);', { table: tableName });

		const ownerA = new RecordId('account', 'query-user-a');
		const ownerB = new RecordId('account', 'query-user-b');
		await db.insert(new Table(tableName), [
			{
				id: new RecordId(tableName, 'q1'),
				title: 'One',
				owner: ownerA,
			},
			{
				id: new RecordId(tableName, 'q2'),
				title: 'Two',
				owner: ownerB,
			},
		]);

		type Calendar = {
			id: RecordId;
			title: string;
			owner: RecordId;
		};

		const queryClient = new QueryClient();
		const calendars = createCollection(
			surrealCollectionOptions<Calendar>({
				db,
				table: { name: tableName },
				queryClient,
				queryKey: [tableName, 'query-driven'],
				syncMode: 'on-demand',
			}),
		);

		const liveQuery = createLiveQueryCollection((query) =>
			query
				.from({ calendar: calendars })
				.where(({ calendar }) => eq(calendar.owner, ownerA)),
		);

		await liveQuery.preload();
		const nativeRows = liveQuery.toArray;
		expect(nativeRows.length).toBe(1);
		expect(toRecordKeyString(nativeRows[0]?.id as RecordId)).toBe('q1');
	});

	it('query-driven eager keeps RecordId WHERE matches after dependency transition', async () => {
			const tableName = createTableName('it_query_where_recordid_eager');
			createdTables.add(tableName);
			await ensureTableSchema(db, tableName);
			await db.query('DELETE type::table($table);', { table: tableName });

			const ownerA = new RecordId('account', 'query-user-a');
			const ownerB = new RecordId('account', 'query-user-b');
			await db.insert(new Table(tableName), [
				{
					id: new RecordId(tableName, 'q1'),
					title: 'One',
					owner: ownerA,
				},
				{
					id: new RecordId(tableName, 'q2'),
					title: 'Two',
					owner: ownerB,
				},
			]);

			type Calendar = {
				id: RecordId;
				title: string;
				owner: RecordId;
			};

			const calendars = createCollection(
				surrealCollectionOptions<Calendar>({
					db,
					table: { name: tableName },
					queryClient: new QueryClient(),
					queryKey: [tableName, 'query-driven-eager'],
					syncMode: 'eager',
				}),
			);

			const unfilteredQuery = createLiveQueryCollection((query) =>
				query.from({ calendar: calendars }),
			);
			await unfilteredQuery.preload();
			expect(unfilteredQuery.toArray.length).toBe(2);

			const profileId = new RecordId('account', 'query-user-a');
			const liveQuery = createLiveQueryCollection((query) =>
				query
					.from({ calendar: calendars })
					.where(({ calendar }) => eq(calendar.owner, profileId)),
			);

			await liveQuery.preload();
			const rows = liveQuery.toArray;
			expect(rows.length).toBe(1);
			expect(toRecordKeyString(rows[0]?.id as RecordId)).toBe('q1');
	});
	});
}
