import { describe, expect, it } from 'bun:test';
import { createCollection } from '@tanstack/db';
import { QueryClient } from '@tanstack/query-core';
import { RecordId } from 'surrealdb';

import { surrealCollectionOptions } from '../src/index';
import type {
	RecordFieldPath,
	StringRecordIds,
} from '../src/internal/string-record-types';
import { recordFieldsToSurreal } from '../src/internal/string-ids';
import { schemaTableOptions } from '../src/schema';
import {
	buildLiveCondition,
	buildSubsetQuery,
	windowBoundaryOf,
} from '../src/table';

const ref = (...path: string[]) => ({ type: 'ref', path }) as const;
const val = (value: unknown) => ({ type: 'val', value }) as const;
const fn = (name: string, ...args: unknown[]) =>
	({ type: 'func', name, args }) as never;
const order = (field: string) =>
	({
		expression: ref(field),
		compareOptions: { direction: 'asc', nulls: 'first' },
	}) as never;

const table = { name: 'item' };
const options = { recordFields: new Set(['id', 'owner', 'links.*']) };
const record = { kind: 'record', tables: ['org'] };

describe('string mode CRDT documents', () => {
	it('keeps numeric, text and compound keys in separate documents', async () => {
		type Doc = { id: string; title: string };
		const updates: Array<{ doc: unknown }> = [];
		const db = {
			isFeatureSupported: () => false,
			query: async () => [[]],
			create: () => ({
				content: async (row: { doc: unknown }) => {
					updates.push(row);
					return [row];
				},
			}),
		};
		const items = createCollection(
			surrealCollectionOptions<Doc>({
				db: db as never,
				table: 'item',
				queryClient: new QueryClient(),
				queryKey: ['item', crypto.randomUUID()],
				syncMode: 'eager',
				recordIds: 'string',
				crdt: {
					enabled: true,
					profile: 'json',
					updatesTable: 'item_update',
				},
			} as never),
		);
		await items.preload();
		const compound = new RecordId('item', [1, 'a']).toString();

		const tx = items.insert([
			{ id: 'item:42', title: 'number' },
			{ id: 'item:⟨42⟩', title: 'text' },
			{ id: compound, title: 'compound' },
		]);
		await tx.when('settled');

		expect(updates.map((row) => String(row.doc))).toEqual([
			'item:42',
			'item:⟨42⟩',
			compound,
		]);
		expect(items.get('item:42')?.title).toBe('number');
		expect(items.get('item:⟨42⟩')?.title).toBe('text');
		expect(items.get(compound)?.title).toBe('compound');
	});
});

describe('string mode range pushdown', () => {
	it('fetches a superset for a range on a record field', () => {
		const { sql, params } = buildSubsetQuery(
			table,
			{ where: fn('lt', ref('id'), val('item:2')) },
			options,
		);
		expect(sql).not.toContain('id <');
		expect(Object.keys(params)).toEqual(['table']);
	});

	it('stays a superset when the range is negated', () => {
		const { sql } = buildSubsetQuery(
			table,
			{
				where: fn(
					'not',
					fn(
						'and',
						fn('eq', ref('name'), val('a')),
						fn('lt', ref('id'), val('item:2')),
					),
				),
			},
			options,
		);
		expect(sql).toContain('NOT ((name = $p0) AND (false))');
	});

	it('keeps the exact side of a conjunction', () => {
		const { sql } = buildSubsetQuery(
			table,
			{
				where: fn(
					'and',
					fn('eq', ref('name'), val('a')),
					fn('gte', ref('owner'), val('org:b')),
				),
			},
			options,
		);
		expect(sql).toContain('(name = $p0) AND (true)');
	});

	it('does not push a window past a record-field range or order', () => {
		const ranged = {
			where: fn('gt', ref('id'), val('item:2')),
			limit: 2,
			offset: 1,
		};
		const ordered = { orderBy: [order('owner')], limit: 2 };
		for (const subset of [ranged, ordered]) {
			const { sql } = buildSubsetQuery(table, subset, options);
			expect(sql).not.toContain('LIMIT');
			expect(sql).not.toContain('START');
			expect(
				windowBoundaryOf(
					table,
					subset,
					[{ id: 'item:1', owner: 'org:a' }, { id: 'item:2', owner: 'org:b' }],
					options,
				),
			).toBeUndefined();
		}
	});

	it('still pushes ranges and windows on ordinary fields', () => {
		const { sql } = buildSubsetQuery(
			table,
			{
				where: fn('gt', ref('rank'), val(1)),
				orderBy: [order('rank')],
				limit: 2,
			},
			options,
		);
		expect(sql).toContain('rank > $p0');
		expect(sql).toContain('LIMIT');
	});

	it('treats a value under a declared wildcard as a record field', () => {
		const { sql } = buildSubsetQuery(
			table,
			{ where: fn('lt', ref('links', 'one'), val('org:b')) },
			options,
		);
		expect(sql).not.toContain('links.one <');
	});

	it('widens the LIVE condition the same way', () => {
		const condition = buildLiveCondition(
			table,
			{ where: fn('lt', ref('id'), val('item:2')) },
			undefined,
			options,
		);
		const sql = condition?.toSQL({ def: () => '$v' });
		expect(sql).not.toContain('id <');
	});
});

describe('schema record paths', () => {
	it('rejects a path that is a record in one object branch and text in another', () => {
		const tables = [
			{
				name: 'item',
				fields: [
					{
						path: ['payload'],
						kind: {
							kind: 'union',
							variants: [
								{
									kind: 'objectLiteral',
									fields: [{ name: 'target', kind: record }],
								},
								{
									kind: 'objectLiteral',
									fields: [
										{ name: 'target', kind: { kind: 'string' } },
									],
								},
							],
						},
					},
				],
			},
		];
		expect(() => schemaTableOptions(tables, 'item')).toThrow(
			'item.payload.target',
		);
	});

	it('keeps object wildcards and converts their values', () => {
		const tables = [
			{
				name: 'item',
				fields: [
					{ path: ['links'], kind: { kind: 'object' } },
					{ path: ['links', '*'], kind: record },
				],
			},
		];
		const { recordFields } = schemaTableOptions(tables, 'item');
		expect(recordFields).toEqual(['links.*']);

		const out = recordFieldsToSurreal(
			{ links: { one: 'org:acme' }, note: 'org:text' },
			recordFields,
		);
		expect(String(out.links.one)).toBe('org:acme');
		expect(out.links.one).not.toBe('org:acme');
		expect(out.note).toBe('org:text');
	});

	it('converts wildcards through arrays of objects', () => {
		const out = recordFieldsToSurreal(
			{ items: [{ owner: 'org:a', label: 'org:b' }] },
			['items.*.owner'],
		);
		expect(out.items[0]?.owner).not.toBe('org:a');
		expect(out.items[0]?.label).toBe('org:b');
	});
});

describe('string record types', () => {
	type Expect<T extends true> = T;
	type Equal<A, B> =
		(<G>() => G extends A ? 1 : 2) extends <G>() => G extends B ? 1 : 2
			? true
			: false;

	it('maps Set elements and finds Set-only links', () => {
		type Row = { id: string; owners: Set<RecordId<'user'>> };
		type Checks = [
			Expect<Equal<StringRecordIds<Row>['owners'], Set<string>>>,
			Expect<Equal<RecordFieldPath<Row>, 'owners'>>,
		];
		expect(true as unknown as Checks).toBeTruthy();
	});

	it('finds links present in only one row-union variant', () => {
		type Row =
			| { id: string; kind: 'plain' }
			| { id: string; kind: 'linked'; org: RecordId<'org'> };
		type Checks = [Expect<Equal<RecordFieldPath<Row>, 'org'>>];
		expect(true as unknown as Checks).toBeTruthy();
	});
});
