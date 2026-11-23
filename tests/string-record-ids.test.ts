import { describe, expect, it } from 'bun:test';
import {
	createCollection,
	createLiveQueryCollection,
	eq,
	inArray,
} from '@tanstack/db';
import { QueryClient } from '@tanstack/query-core';
import { RecordId, StringRecordId } from 'surrealdb';

import { surrealCollectionOptions } from '../src/index';
import {
	recordFieldsToSurreal,
	stringifyRecordIdsDeep,
} from '../src/internal/string-ids';

type User = {
	id: string;
	name: string;
	orgId: string;
	note: string;
	meta?: { manager?: string; tags?: string[] };
};

const schemaTables = [
	{
		name: 'user',
		type: { kind: 'normal' },
		fields: [
			{ path: ['orgId'], kind: { kind: 'record', tables: ['org'] } },
			{
				path: ['meta', 'manager'],
				kind: { kind: 'record', tables: ['user'] },
			},
		],
	},
];

type Write = { op: string; target: string; payload?: unknown };

const serverRows = () => [
	{
		id: new RecordId('user', 'abc'),
		name: 'Alice',
		orgId: new RecordId('org', 'acme'),
		note: 'org:not-a-link',
		meta: { manager: new RecordId('user', 42), tags: ['x'] },
	},
	{
		id: new RecordId('user', '42'),
		name: 'Bob',
		orgId: new RecordId('org', 'other'),
		note: 'plain',
	},
];

const createMockDb = () => {
	const writes: Write[] = [];
	const queries: Array<{ sql: string; params: Record<string, unknown> }> =
		[];
	const db = {
		isFeatureSupported: () => false,
		select: async () => serverRows(),
		query: async (sql: string, params: Record<string, unknown>) => {
			queries.push({ sql, params });
			const rows = serverRows();
			return [sql.includes('WHERE') ? rows.slice(0, 1) : rows];
		},
		insert: async (_table: unknown, payload: Record<string, unknown>) => {
			writes.push({
				op: 'insert',
				target: String(payload.id),
				payload,
			});
			return [payload];
		},
		update: (id: unknown) => ({
			merge: async (payload: unknown) => {
				writes.push({ op: 'update', target: String(id), payload });
			},
		}),
		delete: async (id: unknown) => {
			writes.push({ op: 'delete', target: String(id) });
			expect(id).toBeInstanceOf(StringRecordId);
		},
	};
	return { db, writes, queries };
};

const createUsers = (
	db: unknown,
	syncMode: 'eager' | 'on-demand',
	queryKey: string,
) =>
	createCollection(
		surrealCollectionOptions<User>({
			db: db as never,
			table: 'user',
				tables: schemaTables,
			queryClient: new QueryClient(),
			queryKey: ['user', queryKey],
			syncMode,
			recordIds: 'string',
		}),
	);

const loadAll = async (users: ReturnType<typeof createUsers>) => {
	const all = createLiveQueryCollection((q) => q.from({ user: users }));
	await all.preload();
	return all;
};

describe("recordIds: 'string'", () => {
	it('exposes record ids as lossless strings, deeply', async () => {
		const { db } = createMockDb();
		const users = createUsers(db, 'eager', 'read');
		await loadAll(users);

		expect([...users.keys()].sort()).toEqual(['user:abc', 'user:⟨42⟩']);
		const alice = users.get('user:abc');
		expect(alice).toMatchObject({
			id: 'user:abc',
			name: 'Alice',
			orgId: 'org:acme',
			note: 'org:not-a-link',
			meta: { manager: 'user:42', tags: ['x'] },
		});
	});

	it('matches eq() on plain string ids and record fields', async () => {
		const { db } = createMockDb();
		const users = createUsers(db, 'eager', 'eq');
		await loadAll(users);

		const byId = createLiveQueryCollection((q) =>
			q
				.from({ user: users })
				.where(({ user }) => eq(user.id, 'user:⟨42⟩')),
		);
		await byId.preload();
		expect(byId.toArray.map((row) => row.name)).toEqual(['Bob']);

		const byOrg = createLiveQueryCollection((q) =>
			q
				.from({ user: users })
				.where(({ user }) => eq(user.orgId, 'org:acme')),
		);
		await byOrg.preload();
		expect(byOrg.toArray.map((row) => row.name)).toEqual(['Alice']);
	});

	it('sends record ids for id and record fields on writes', async () => {
		const { db, writes } = createMockDb();
		const users = createUsers(db, 'eager', 'write');
		await loadAll(users);

		await users.insert({
			id: 'user:new',
			name: 'Carol',
			orgId: 'org:acme',
			note: 'org:still-text',
			meta: { manager: 'user:abc' },
		}).when('settled');
		await users.update('user:abc', (draft) => {
			draft.orgId = 'org:other';
		}).when('settled');
		await users.delete('user:⟨42⟩').when('settled');

		const [insert, update, remove] = writes;
		expect(insert?.op).toBe('insert');
		const inserted = insert?.payload as Record<string, unknown>;
		expect(inserted.id).toBeInstanceOf(StringRecordId);
		expect(String(inserted.id)).toBe('user:new');
		expect(inserted.orgId).toBeInstanceOf(StringRecordId);
		expect(String(inserted.orgId)).toBe('org:acme');
		expect(inserted.note).toBe('org:still-text');
		const meta = inserted.meta as Record<string, unknown>;
		expect(meta.manager).toBeInstanceOf(StringRecordId);
		expect(String(meta.manager)).toBe('user:abc');
		expect(users.get('user:new')?.orgId).toBe('org:acme');

		expect(update?.op).toBe('update');
		expect(update?.target).toBe('user:abc');
		const merged = update?.payload as Record<string, unknown>;
		expect(merged.orgId).toBeInstanceOf(StringRecordId);
		expect(String(merged.orgId)).toBe('org:other');
		expect(Object.keys(merged)).toEqual(['orgId']);

		expect(remove).toEqual({ op: 'delete', target: 'user:⟨42⟩' });
		expect(users.has('user:⟨42⟩')).toBe(false);
	});

	it('converts record ids inside a Set in both directions', () => {
		const read = stringifyRecordIdsDeep({
			uniq: new Set([new RecordId('org', 'acme')]),
		});
		expect([...read.uniq]).toEqual(['org:acme'] as never);

		const written = recordFieldsToSurreal(read, ['uniq']);
		const [link] = [...written.uniq];
		expect(link).toBeInstanceOf(StringRecordId);
		expect(String(link)).toBe('org:acme');
	});

	it('leaves untouched record links out of an update', async () => {
		const { db, writes } = createMockDb();
		const users = createCollection(
			surrealCollectionOptions<User>({
				db: db as never,
				table: { name: 'user' },
				queryClient: new QueryClient(),
				queryKey: ['user', 'unlisted'],
				recordIds: 'string',
			}),
		);
		await loadAll(users as never);

		await users.update('user:abc', (draft) => {
			draft.name = 'Renamed';
		}).when('settled');

		expect(writes[0]?.payload).toEqual({ name: 'Renamed' });
		expect(users.get('user:abc')?.orgId).toBe('org:acme');
	});

	it('converts a nested record link in a partial update', async () => {
		const { db, writes } = createMockDb();
		const users = createUsers(db, 'eager', 'nested-update');
		await loadAll(users);

		await users.update('user:abc', (draft) => {
			if (draft.meta) draft.meta.manager = 'user:new';
		}).when('settled');

		const payload = writes[0]?.payload as {
			meta: { manager: unknown };
		};
		expect(Object.keys(payload)).toEqual(['meta']);
		expect(payload.meta.manager).toBeInstanceOf(StringRecordId);
		expect(String(payload.meta.manager)).toBe('user:new');
	});

	it('derives string rows and requires schema tables for a RecordId row type', async () => {
		type NativeUser = {
			id: RecordId<'user'>;
			name: string;
			orgId: RecordId<'org'>;
			note: string;
			meta?: { manager?: RecordId<'user'>; tags?: string[] };
		};
		const { db, writes } = createMockDb();
		const base = {
			db: db as never,
			queryClient: new QueryClient(),
			recordIds: 'string',
		} as const;

		// @ts-expect-error a row with record links needs SurrealKit's tables
		surrealCollectionOptions<NativeUser>({
			...base,
			table: { name: 'user' },
			queryKey: ['user', 'typed-missing'],
		});

		const users = createCollection(
			surrealCollectionOptions<NativeUser>({
				...base,
				table: 'user',
				tables: schemaTables,
				queryKey: ['user', 'typed'],
			}),
		);
		const all = createLiveQueryCollection((q) => q.from({ user: users }));
		await all.preload();

		const orgId: string | undefined = users.get('user:abc')?.orgId;
		expect(orgId).toBe('org:acme');
		await users.update('user:abc', (draft) => {
			draft.orgId = 'org:other';
		}).when('settled');
		const payload = writes[0]?.payload as Record<string, unknown>;
		expect(payload.orgId).toBeInstanceOf(StringRecordId);
	});

	it('assigns string temp ids to inserts without an id', async () => {
		const { db } = createMockDb();
		const users = createUsers(db, 'eager', 'temp');
		const schema = surrealCollectionOptions<User>({
			db: db as never,
			table: { name: 'user' },
			queryClient: new QueryClient(),
			queryKey: ['user', 'temp-schema'],
			recordIds: 'string',
		}).schema;
		const result = await schema['~standard'].validate({
			name: 'Dan',
			orgId: new RecordId('org', 'acme'),
		});
		const value = (result as { value: User }).value;
		expect(value.id.startsWith('user:')).toBe(true);
		expect(value.orgId).toBe('org:acme');
		expect(users).toBeDefined();
	});

	it('pushes down id and record field filters as record ids', async () => {
		const { db, queries } = createMockDb();
		const users = createUsers(db, 'on-demand', 'pushdown');

		const byId = createLiveQueryCollection((q) =>
			q
				.from({ user: users })
				.where(({ user }) => eq(user.id, 'user:abc')),
		);
		await byId.preload();
		expect(byId.toArray.map((row) => row.id)).toEqual(['user:abc']);

		const byOrg = createLiveQueryCollection((q) =>
			q
				.from({ user: users })
				.where(({ user }) =>
					inArray(user.orgId, ['org:acme', 'org:other']),
				),
		);
		await byOrg.preload();

		const byNote = createLiveQueryCollection((q) =>
			q
				.from({ user: users })
				.where(({ user }) => eq(user.note, 'org:not-a-link')),
		);
		await byNote.preload();

		const idQuery = queries.find((q) => q.sql.includes('WHERE (id = '));
		expect(idQuery?.sql).toContain('WHERE (id = $p0)');
		expect(idQuery?.params.p0).toBeInstanceOf(StringRecordId);
		expect(String(idQuery?.params.p0)).toBe('user:abc');

		const orgQuery = queries.find((q) => q.sql.includes('orgId IN'));
		const orgParam = orgQuery?.params.p0 as unknown[];
		expect(orgParam.map(String)).toEqual(['org:acme', 'org:other']);
		for (const value of orgParam) {
			expect(value).toBeInstanceOf(StringRecordId);
		}

		const noteQuery = queries.find((q) => q.sql.includes('note ='));
		expect(noteQuery?.params.p0).toBe('org:not-a-link');
	});

	it('keeps native RecordIds by default', async () => {
		const { db, queries } = createMockDb();
		const users = createCollection(
			surrealCollectionOptions<{
				id: RecordId;
				name: string;
				orgId: RecordId;
			}>({
				db: db as never,
				table: { name: 'user' },
				queryClient: new QueryClient(),
				queryKey: ['user', 'native'],
				syncMode: 'on-demand',
			}),
		);
		const byOrg = createLiveQueryCollection((q) =>
			q
				.from({ user: users })
				.where(({ user }) =>
					eq(user.orgId, new RecordId('org', 'acme')),
				),
		);
		await byOrg.preload();

		const row = byOrg.toArray[0];
		expect(row?.id).toBeInstanceOf(RecordId);
		expect(row?.orgId).toBeInstanceOf(RecordId);
		expect(queries[0]?.params.p0).toBeInstanceOf(RecordId);
		expect([...users.keys()]).toEqual(['user:abc']);
	});
});
