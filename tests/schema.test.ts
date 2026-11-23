import { describe, expect, it } from 'bun:test';
import { schemaTableOptions } from '../src/schema';

const record = { kind: 'record', tables: ['org'] };

describe('schemaTableOptions', () => {
	it('finds direct, optional, nested, array, set and literal links', () => {
		const tables = [
			{
				name: 'profile',
				type: { kind: 'normal' },
				fields: [
					{ path: ['orgId'], kind: record },
					{
						path: ['nullable'],
						kind: {
							kind: 'union',
							variants: [{ kind: 'null' }, record],
						},
					},
					{ path: ['meta', 'manager'], kind: record },
					{ path: ['members'], kind: { kind: 'array', item: record } },
					{ path: ['members', '*'], kind: record },
					{ path: ['uniq'], kind: { kind: 'set', item: record } },
					{ path: ['items', '*', 'owner'], kind: record },
					{
						path: ['lit'],
						kind: {
							kind: 'objectLiteral',
							fields: [
								{ name: 'owner', kind: record },
								{ name: 'label', kind: { kind: 'string' } },
							],
						},
					},
					{ path: ['note'], kind: { kind: 'string' } },
				],
			},
		];

		expect(schemaTableOptions(tables, 'profile')).toEqual({
			relation: false,
			recordFields: [
				'items.*.owner',
				'lit.owner',
				'members',
				'members.*',
				'meta.manager',
				'nullable',
				'orgId',
				'uniq',
			],
		});
	});

	it('marks relations and leaves in and out to the adapter', () => {
		const tables = [
			{
				name: 'follows',
				type: { kind: 'relation' },
				fields: [
					{ path: ['in'], kind: record },
					{ path: ['out'], kind: record },
					{ path: ['by'], kind: record },
				],
			},
		];
		expect(schemaTableOptions(tables, 'follows')).toEqual({
			relation: true,
			recordFields: ['by'],
		});
	});

	it('rejects a field that can hold both a record and a string', () => {
		const tables = [
			{
				name: 'profile',
				fields: [
					{
						path: ['mixed'],
						kind: {
							kind: 'union',
							variants: [record, { kind: 'string' }],
						},
					},
				],
			},
		];
		expect(() => schemaTableOptions(tables, 'profile')).toThrow(
			'profile.mixed',
		);
	});

	it('rejects a table missing from the schema', () => {
		expect(() => schemaTableOptions([], 'profile')).toThrow(
			'Table "profile"',
		);
	});

	it('rejects tables from an older document format', () => {
		const tables = [
			{ name: 'user', fields: [{ name: 'orgId' }] },
		] as never;
		expect(() => schemaTableOptions(tables, 'user')).toThrow('version 2');
	});
});
