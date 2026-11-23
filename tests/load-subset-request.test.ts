import { describe, expect, it } from 'bun:test';
import {
	createCollection,
	createLiveQueryCollection,
	eq,
	inArray,
	type LoadSubsetOptions,
} from '@tanstack/db';
import { QueryClient } from '@tanstack/query-core';
import { RecordId } from 'surrealdb';

import { surrealCollectionOptions } from '../src/index';

type User = { id: RecordId<'user'>; name: string; orgId?: RecordId<'org'> };

const makeUsers = (rows: () => User[], queryKey: string) => {
	const queries: Array<{ sql: string; params: Record<string, unknown> }> = [];
	const db = {
		query: async (sql: string, params: Record<string, unknown>) => {
			queries.push({ sql, params });
			return [rows()];
		},
		isFeatureSupported: () => false,
		live: async () => ({ subscribe() {}, kill: async () => {} }),
		select: async () => [],
	};
	const options = surrealCollectionOptions<User>({
		db: db as never,
		table: { name: 'user' },
		queryClient: new QueryClient(),
		queryKey: ['user', queryKey],
		syncMode: 'on-demand',
	});
	return { options, collection: createCollection(options), queries };
};

// Every `val` node in an expression tree, with the value it holds.
const valNodes = (
	expr: unknown,
	out: Array<{ node: object; value: unknown }> = [],
) => {
	if (Array.isArray(expr)) {
		for (const entry of expr) valNodes(entry, out);
		return out;
	}
	if (!expr || typeof expr !== 'object') return out;
	const node = expr as Record<string, unknown>;
	if (node.type === 'val') out.push({ node, value: node.value });
	if (Array.isArray(node.args)) valNodes(node.args, out);
	return out;
};

describe('loadSubset request', () => {
	it('does not mutate the request or its where expression', async () => {
		const rid = new RecordId('user', 'abc');
		const orgIds = [new RecordId('org', 'a'), 'org:b'];
		const { options } = makeUsers(
			() => [{ id: new RecordId('user', 'abc'), name: 'A' }],
			'no-mutate',
		);

		const where = {
			type: 'func',
			name: 'and',
			args: [
				{
					type: 'func',
					name: 'eq',
					args: [
						{ type: 'ref', path: ['id'] },
						{ type: 'val', value: rid },
					],
				},
				{
					type: 'func',
					name: 'eq',
					args: [
						{ type: 'ref', path: ['name'] },
						{ type: 'val', value: 'user:not-an-id-field' },
					],
				},
				{
					type: 'func',
					name: 'in',
					args: [
						{ type: 'ref', path: ['orgId'] },
						{ type: 'val', value: orgIds },
					],
				},
			],
		} as unknown as LoadSubsetOptions['where'];
		const request: LoadSubsetOptions = { where, limit: 10 };

		const before = valNodes(where);
		const snapshot = structuredClone({
			...request,
			where: JSON.parse(JSON.stringify(where)),
		});

		const begin = () => {};
		const write = () => {};
		const commit = () => {};
		const markReady = () => {};
		const sync = options.sync.sync({
			collection: {
				entries: () => [][Symbol.iterator](),
				_state: { createSyncedKeyLookup: () => () => false },
			},
			begin,
			write,
			commit,
			markReady,
			truncate: () => {},
		} as never) as { loadSubset?: (s: LoadSubsetOptions) => unknown };
		await sync?.loadSubset?.(request);

		const after = valNodes(where);
		expect(after.length).toBe(before.length);
		for (let i = 0; i < before.length; i++) {
			expect(after[i].node).toBe(before[i].node);
			expect(after[i].value).toBe(before[i].value);
		}
		expect(orgIds[0]).toBeInstanceOf(RecordId);
		expect(orgIds[1]).toBe('org:b');
		expect({
			...request,
			where: JSON.parse(JSON.stringify(where)),
		}).toEqual(snapshot);
	});

	it('leaves the request TanStack DB sends untouched', async () => {
		const { options } = makeUsers(
			() => [
				{
					id: new RecordId('user', 'abc'),
					name: 'A',
					orgId: new RecordId('org', 'a'),
				},
			],
			'live-no-mutate',
		);
		const seen: Array<{
			where: unknown;
			before: Array<{ node: object; value: unknown }>;
			json: string;
		}> = [];
		const sync = options.sync.sync;
		options.sync.sync = ((params: Parameters<typeof sync>[0]) => {
			const result = sync(params) as {
				loadSubset?: (s: LoadSubsetOptions) => unknown;
			};
			const loadSubset = result?.loadSubset;
			if (loadSubset) {
				result.loadSubset = (subset: LoadSubsetOptions) => {
					seen.push({
						where: subset.where,
						before: valNodes(subset.where),
						json: JSON.stringify(subset.where),
					});
					return loadSubset(subset);
				};
			}
			return result;
		}) as typeof sync;
		const collection = createCollection(options);

		const orgIds = ['org:a', new RecordId('org', 'b')];
		const live = createLiveQueryCollection((q) =>
			q
				.from({ user: collection })
				.where(({ user }) => eq(user.name, 'A'))
				.where(({ user }) => inArray(user.orgId, orgIds)),
		);
		live.subscribeChanges(() => {});
		await live.preload();

		expect(seen.length).toBeGreaterThan(0);
		for (const request of seen) {
			const after = valNodes(request.where);
			expect(after.length).toBe(request.before.length);
			for (let i = 0; i < after.length; i++) {
				expect(after[i].node).toBe(request.before[i].node);
				expect(after[i].value).toBe(request.before[i].value);
			}
			expect(JSON.stringify(request.where)).toBe(request.json);
		}
		expect(orgIds[0]).toBe('org:a');
	});

	it('still matches rows already loaded when a filter uses a fresh RecordId', async () => {
		const { collection } = makeUsers(
			() => [{ id: new RecordId('user', 'abc'), name: 'A' }],
			'fresh-instance',
		);
		const all = createLiveQueryCollection((q) =>
			q.from({ user: collection }),
		);
		all.subscribeChanges(() => {});
		await all.preload();
		expect(all.toArray.length).toBe(1);

		const id = new RecordId('user', 'abc');
		const byId = createLiveQueryCollection((q) =>
			q
				.from({ user: collection })
				.where(({ user }) => eq(user.id, id))
				.findOne(),
		);
		byId.subscribeChanges(() => {});
		await byId.preload();
		expect(byId.toArray.length).toBe(1);
	});

	// TanStack DB's `eq` compares class instances by reference, and a stored row
	// holds one `RecordId` instance, so only one of two equal-but-distinct
	// predicate instances can match at a time. The adapter rebinds rows to the
	// instance the latest load used; fixing this needs value-based `eq` upstream.
	it.todo('keeps an earlier live query matching after a later one loads the same record with an equal RecordId', async () => {
		const { collection } = makeUsers(
			() => [{ id: new RecordId('user', 'abc'), name: 'A' }],
			'two-instances',
		);
		const byId = (id: RecordId<'user'>) =>
			createLiveQueryCollection((q) =>
				q
					.from({ user: collection })
					.where(({ user }) => eq(user.id, id))
					.findOne(),
			);

		const a = byId(new RecordId('user', 'abc'));
		a.subscribeChanges(() => {});
		await a.preload();
		const b = byId(new RecordId('user', 'abc'));
		b.subscribeChanges(() => {});
		await b.preload();

		expect(a.toArray.length).toBe(1);
		expect(b.toArray.length).toBe(1);
	});
});
