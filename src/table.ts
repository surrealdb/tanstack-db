import { parseOrderByExpression, parseWhereExpression } from '@tanstack/db';
import {
	type Expr,
	Features,
	type LiveMessage,
	type LiveSubscription,
	type RecordId,
	type Surreal,
	Table,
} from 'surrealdb';
import {
	normalizeRecordIdLikeValue,
	toNativeRecordIdLikeValue,
	toRecordId,
} from './id';
import { firstRow } from './internal/records';
import { isRecordFieldPath, toSurrealRecordId } from './internal/string-ids';
import type { SurrealSubset, TableOptions } from './types';

type QueryResult<T> = T[] | null;
type FieldPath = Array<string | number>;
// `sql` matches at least the rows the predicate matches. `narrow`, set when
// the server can't evaluate it exactly, matches at most those rows.
type SqlFragment = { sql: string; narrow?: string };

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const toFieldPath = (value: unknown): FieldPath => {
	if (!Array.isArray(value)) {
		throw new Error('Expected a field path array in where expression.');
	}
	return value as FieldPath;
};

const quoteIdentifier = (segment: string): string => {
	if (IDENTIFIER_RE.test(segment)) return segment;
	return `\`${segment.replaceAll('`', '\\`')}\``;
};

const formatFieldPath = (path: FieldPath): string => {
	let out = '';
	for (const segment of path) {
		if (typeof segment === 'number') {
			out += `[${segment}]`;
			continue;
		}
		const next = quoteIdentifier(segment);
		out = out ? `${out}.${next}` : next;
	}
	return out;
};

const isReferencePathCandidate = (value: unknown): value is FieldPath =>
	Array.isArray(value) &&
	value.length > 0 &&
	typeof value[0] === 'string' &&
	value.every(
		(segment) => typeof segment === 'string' || typeof segment === 'number',
	);

const mapRelationPath = (path: FieldPath, relation?: boolean): FieldPath => {
	if (!relation) return path;
	if (path[0] === 'from') return ['in', ...path.slice(1)];
	if (path[0] === 'to') return ['out', ...path.slice(1)];
	return path;
};

const normalizeFilterValue = (value: unknown): unknown => {
	if (Array.isArray(value))
		return value.map((item) => normalizeFilterValue(item));

	const native = toNativeRecordIdLikeValue(value);
	if (native !== value) return native;

	if (value && typeof value === 'object')
		return normalizeRecordIdLikeValue(value);

	return normalizeRecordIdLikeValue(value);
};

const toSqlFragment = (value: unknown): SqlFragment => {
	if (
		typeof value === 'object' &&
		value !== null &&
		'sql' in value &&
		typeof (value as { sql: unknown }).sql === 'string'
	) {
		return value as SqlFragment;
	}
	throw new Error('Unsupported where expression node.');
};

const joinSql = (op: 'AND' | 'OR', parts: string[]): string => {
	if (parts.length === 0) return op === 'AND' ? 'true' : 'false';
	if (parts.length === 1) return parts[0] as string;
	return parts.map((part) => `(${part})`).join(` ${op} `);
};

const sqlFragment = (sql: string, narrow: string): SqlFragment =>
	sql === narrow ? { sql } : { sql, narrow };

const joinLogical = (op: 'AND' | 'OR', args: Array<unknown>): SqlFragment => {
	const fragments = args.map(toSqlFragment);
	return sqlFragment(
		joinSql(
			op,
			fragments.map((frag) => frag.sql),
		),
		joinSql(
			op,
			fragments.map((frag) => frag.narrow ?? frag.sql),
		),
	);
};

const negate = (arg: unknown): SqlFragment => {
	const frag = toSqlFragment(arg);
	return sqlFragment(`NOT (${frag.narrow ?? frag.sql})`, `NOT (${frag.sql})`);
};

// Evaluated locally: the server compares native record keys, TanStack DB
// compares their string form.
const LOCAL_ONLY: SqlFragment = { sql: 'true', narrow: 'false' };

type BindParam = (value: unknown) => string;

export type SubsetQueryOptions = {
	/**
	 * When set, values compared against these fields (dot paths, including
	 * `id`) are sent as record ids and all other values are sent unchanged.
	 * Used by `recordIds: 'string'`.
	 */
	recordFields?: ReadonlySet<string>;
};

const isStringRecordField = (
	table: TableOptions,
	options: SubsetQueryOptions,
	fieldPath: unknown,
): boolean =>
	options.recordFields !== undefined &&
	isRecordFieldPath(
		options.recordFields,
		mapRelationPath(toFieldPath(fieldPath), table.relation),
	);

const filterValueFor = (
	table: TableOptions,
	options: SubsetQueryOptions,
	fieldPath: unknown,
	value: unknown,
): unknown => {
	if (!options.recordFields) return normalizeFilterValue(value);
	return isStringRecordField(table, options, fieldPath)
		? toSurrealRecordId(value)
		: value;
};

type WhereExpression = NonNullable<SurrealSubset['where']>;

export type SubsetOrder = {
	field: FieldPath;
	direction: 'asc' | 'desc';
};

export type WindowBoundary = SubsetOrder & { value: unknown };

const whereFragmentFrom = (
	table: TableOptions,
	expr: WhereExpression,
	bind: BindParam,
	scope?: string,
	options: SubsetQueryOptions = {},
): SqlFragment | undefined => {
	const filterValue = (fieldPath: unknown, value: unknown) =>
		filterValueFor(table, options, fieldPath, value);
	const fieldSql = (fieldPath: unknown): string => {
		const field = formatFieldPath(
			mapRelationPath(toFieldPath(fieldPath), table.relation),
		);
		return scope ? `${scope}.${field}` : field;
	};
	const comparison = (
		fieldPath: unknown,
		op: '=' | '!=' | '>' | '>=' | '<' | '<=' | 'LIKE',
		value: unknown,
	): SqlFragment => {
		const field = fieldSql(fieldPath);

		if (value === undefined) {
			if (op === '=') return { sql: `${field} IS NONE` };
			if (op === '!=') return { sql: `${field} IS NOT NONE` };
			throw new Error(
				`Cannot compare field '${field}' with undefined using '${op}'.`,
			);
		}

		if (isReferencePathCandidate(value)) {
			throw new Error(
				'Got a field reference on the right side of a where comparison. Pass a concrete value.',
			);
		}
		if (op !== '=' && op !== '!=') {
			if (isStringRecordField(table, options, fieldPath))
				return LOCAL_ONLY;
		}
		return {
			sql: `${field} ${op} ${bind(filterValue(fieldPath, value))}`,
		};
	};

	const fragment = parseWhereExpression<SqlFragment>(expr, {
		handlers: {
			and: (...args) => joinLogical('AND', args),
			or: (...args) => joinLogical('OR', args),
			not: negate,
			eq: (field, value) => comparison(field, '=', value),
			gt: (field, value) => comparison(field, '>', value),
			gte: (field, value) => comparison(field, '>=', value),
			lt: (field, value) => comparison(field, '<', value),
			lte: (field, value) => comparison(field, '<=', value),
			like: (field, value) => comparison(field, 'LIKE', value),
			ilike: (field, value) => {
				if (isStringRecordField(table, options, field))
					return LOCAL_ONLY;
				const f = fieldSql(field);
				const p = bind(filterValue(field, value));
				return {
					sql: `string::lower(${f}) LIKE string::lower(${p})`,
				};
			},
			in: (field, value) => {
				const f = fieldSql(field);
				if (Array.isArray(value) && value.length === 0) {
					return { sql: 'false' };
				}
				return {
					sql: `${f} IN ${bind(filterValue(field, value))}`,
				};
			},
			isNull: (field) => ({ sql: `${fieldSql(field)} IS NULL` }),
			isUndefined: (field) => ({ sql: `${fieldSql(field)} IS NONE` }),
		},
		onUnknownOperator: (op) => {
			throw new Error(
				`Unsupported where operator '${op}' for SurrealQL translation.`,
			);
		},
	});

	return fragment ?? undefined;
};

const whereSqlFrom = (
	table: TableOptions,
	expr: WhereExpression,
	bind: BindParam,
	scope?: string,
	options: SubsetQueryOptions = {},
): string => whereFragmentFrom(table, expr, bind, scope, options)?.sql ?? '';

const subsetFilters = (subset?: SurrealSubset): WhereExpression[] =>
	[subset?.where, subset?.cursor?.whereFrom].filter(
		(expr): expr is WhereExpression => Boolean(expr),
	);

const filterSqlFrom = (
	table: TableOptions,
	subset: SurrealSubset | undefined,
	bind: BindParam,
	scope?: string,
	options: SubsetQueryOptions = {},
): string[] =>
	subsetFilters(subset)
		.map((expr) => whereSqlFrom(table, expr, bind, scope, options))
		.filter(Boolean);

/**
 * Whether LIMIT and START can run on the server. A filter or order the server
 * can't evaluate like TanStack DB would pick a different window, so those
 * subsets fetch every candidate row and TanStack DB applies the window.
 */
export const pushesSubsetWindow = (
	table: TableOptions,
	subset: SurrealSubset | undefined,
	options: SubsetQueryOptions = {},
): boolean => {
	if (!options.recordFields) return true;
	const exactFilters = subsetFilters(subset).every(
		(expr) =>
			whereFragmentFrom(table, expr, () => '$_', undefined, options)
				?.narrow === undefined,
	);
	return (
		exactFilters &&
		!parseOrderByExpression(subset?.orderBy).some((clause) =>
			isStringRecordField(table, options, clause.field),
		)
	);
};

const isOrdered = (subset?: SurrealSubset): boolean =>
	Boolean(subset?.orderBy?.length) ||
	typeof subset?.limit === 'number' ||
	typeof subset?.offset === 'number';

export const subsetOrderOf = (
	table: TableOptions,
	subset?: SurrealSubset,
): SubsetOrder[] => {
	if (!isOrdered(subset)) return [];
	const order: SubsetOrder[] = parseOrderByExpression(subset?.orderBy).map(
		(clause) => ({
			field: mapRelationPath(clause.field, table.relation),
			direction: clause.direction,
		}),
	);
	const hasId = order.some(
		(clause) => clause.field.length === 1 && clause.field[0] === 'id',
	);
	if (!hasId) order.push({ field: ['id'], direction: 'asc' });
	return order;
};

export const readFieldPath = (row: unknown, path: FieldPath): unknown => {
	let value = row;
	for (const segment of path) {
		if (value === null || typeof value !== 'object') return undefined;
		value = (value as Record<string | number, unknown>)[segment];
	}
	return value;
};

export const windowBoundaryOf = (
	table: TableOptions,
	subset: SurrealSubset | undefined,
	rows: ReadonlyArray<unknown>,
	options: SubsetQueryOptions = {},
): WindowBoundary | undefined => {
	if (!pushesSubsetWindow(table, subset, options)) return undefined;
	const limit = subset?.limit;
	if (typeof limit !== 'number' || rows.length === 0) return undefined;
	if (rows.length < limit) return undefined;
	const leading = subsetOrderOf(table, subset)[0];
	if (!leading) return undefined;
	const value = readFieldPath(rows[rows.length - 1], leading.field);
	if (value === undefined || value === null) return undefined;
	return { ...leading, value };
};

const boundarySql = (
	table: TableOptions,
	boundary: WindowBoundary,
	bind: BindParam,
	scope?: string,
	options: SubsetQueryOptions = {},
): string => {
	const path = formatFieldPath(boundary.field);
	const field = scope ? `${scope}.${path}` : path;
	const op = boundary.direction === 'desc' ? '>=' : '<=';
	const value = bind(
		filterValueFor(table, options, boundary.field, boundary.value),
	);
	return `${field} ${op} ${value} OR ${field} IS NONE OR ${field} IS NULL`;
};

export const buildSubsetQuery = (
	table: TableOptions,
	subset?: SurrealSubset,
	options: SubsetQueryOptions = {},
): { sql: string; params: Record<string, unknown> } => {
	let paramIdx = 0;
	const params: Record<string, unknown> = { table: table.name };
	const nextParam: BindParam = (value) => {
		const key = `p${paramIdx++}`;
		params[key] = value;
		return `$${key}`;
	};

	const whereParts = filterSqlFrom(
		table,
		subset,
		nextParam,
		undefined,
		options,
	);
	const whereSql = whereParts.length
		? ` WHERE ${whereParts.map((part) => `(${part})`).join(' AND ')}`
		: '';

	const order = subsetOrderOf(table, subset);
	const orderSql = order.length
		? ` ORDER BY ${order
				.map(
					(clause) =>
						`${formatFieldPath(clause.field)} ${clause.direction.toUpperCase()}`,
				)
				.join(', ')}`
		: '';
	const windowed = pushesSubsetWindow(table, subset, options);
	const limitSql =
		windowed && typeof subset?.limit === 'number'
			? ` LIMIT ${nextParam(subset.limit)}`
			: '';
	const offsetSql =
		windowed && typeof subset?.offset === 'number'
			? ` START ${nextParam(subset.offset)}`
			: '';

	return {
		sql: `SELECT * FROM type::table($table)${whereSql}${orderSql}${limitSql}${offsetSql};`,
		params,
	};
};

export const buildLiveCondition = (
	table: TableOptions,
	subset?: SurrealSubset,
	boundary?: WindowBoundary,
	options: SubsetQueryOptions = {},
): Expr | undefined => {
	const scoped = (bind: BindParam, scope?: string): string[] => {
		const parts = filterSqlFrom(table, subset, bind, scope, options);
		if (boundary) {
			parts.push(boundarySql(table, boundary, bind, scope, options));
		}
		return parts;
	};
	if (!subsetFilters(subset).length && !boundary) return undefined;

	const conjunction = (parts: string[]): string =>
		parts.map((part) => `(${part})`).join(' AND ');

	return {
		toSQL: (ctx) =>
			`(${conjunction(scoped(ctx.def))}) OR ($before IS NOT NONE AND ${conjunction(
				scoped(ctx.def, '$before'),
			)})`,
	};
};

export function manageTable<T extends { id: string | RecordId }>(
	db: Surreal,
	config: TableOptions,
	subsetQueryOptions?: SubsetQueryOptions,
) {
	const { name } = config;
	const table = new Table(name);

	const listAll = async (): Promise<T[]> => {
		return loadSubset();
	};

	const loadSubset = async (subset?: SurrealSubset): Promise<T[]> => {
		const { sql, params } = buildSubsetQuery(
			config,
			subset,
			subsetQueryOptions,
		);
		const [res] = await db.query<[QueryResult<T>]>(sql, params);
		return res ?? [];
	};

	const create = async (data: T | Partial<T>): Promise<T | undefined> => {
		const id = (data as Partial<T> & { id?: string | RecordId }).id;
		if (!id) {
			const created = await db.create(table).content(data);
			return firstRow(created as T | T[] | null);
		}

		const payload = { ...(data as Record<string, unknown>) };
		payload.id = toRecordId(name, id);
		const inserted = await db.insert(table, payload);
		return firstRow(inserted as T | T[] | null);
	};

	const update = async (id: RecordId, data: T | Partial<T>) => {
		const { id: _ignoredId, ...rest } = data as Record<string, unknown>;
		await db.update(id).merge(rest);
	};

	const remove = async (id: RecordId) => {
		await db.delete(id);
	};

	const subscribe = (
		cb: (e: { type: 'insert' | 'update' | 'delete'; row: T }) => void,
	) => {
		let killed = false;
		let live: LiveSubscription | undefined;

		const on = (msg: LiveMessage) => {
			const { action, value } = msg as unknown as {
				action: 'CREATE' | 'UPDATE' | 'DELETE' | 'KILLED';
				value: T & { id: string | RecordId };
			};

			if (action === 'KILLED') return;
			if (action === 'CREATE') cb({ type: 'insert', row: value });
			else if (action === 'UPDATE') cb({ type: 'update', row: value });
			else if (action === 'DELETE')
				cb({ type: 'delete', row: { id: value.id } as T });
		};

		const start = async () => {
			if (!db.isFeatureSupported(Features.LiveQueries)) return;
			live = await db.live(table);
			live.subscribe(on);
		};

		void start();

		return () => {
			if (killed) return;
			killed = true;
			if (live) void live.kill();
		};
	};

	return {
		listAll,
		loadSubset,
		create,
		update,
		remove,
		softDelete: remove,
		subscribe,
	};
}
