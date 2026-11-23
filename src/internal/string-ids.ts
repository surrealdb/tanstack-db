import { RecordId, StringRecordId } from 'surrealdb';
import { isCrossRuntimeRecordIdObject } from '../id';
import { isPlainObject } from './records';

/**
 * Lossless SurrealQL string form of a record id (`RecordId#toString()`),
 * e.g. `user:abc`, `user:42` (number key) or `user:⟨42⟩` (string key).
 */
export const recordIdToString = (value: unknown): string | undefined => {
	if (value instanceof RecordId) return value.toString();
	if (isCrossRuntimeRecordIdObject(value)) return String(value.toString());
	return undefined;
};

/** Deeply replaces every record id with its lossless string form. */
export const stringifyRecordIdsDeep = <T>(value: T): T => {
	const asString = recordIdToString(value);
	if (asString !== undefined) return asString as T;
	if (Array.isArray(value)) {
		return value.map((item) => stringifyRecordIdsDeep(item)) as T;
	}
	if (value instanceof Set) {
		return new Set(
			[...value].map((item) => stringifyRecordIdsDeep(item)),
		) as T;
	}
	if (isPlainObject(value)) {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			out[k] = stringifyRecordIdsDeep(v);
		}
		return out as T;
	}
	return value;
};

/**
 * Resolves a row id to the string form used as the TanStack DB key.
 * Strings already prefixed with the table are kept as-is; bare keys are
 * treated as string keys of `tableName`.
 */
export const toTableRecordIdString = (
	tableName: string,
	id: unknown,
): string => {
	const asString = recordIdToString(id);
	if (asString !== undefined) return asString;
	if (id instanceof StringRecordId) return id.toString();
	const raw = String(id);
	const escapedPrefix = new RecordId(tableName, 'x').toString().slice(0, -1);
	if (raw.startsWith(escapedPrefix) || raw.startsWith(`${tableName}:`)) {
		return raw;
	}
	return new RecordId(tableName, raw).toString();
};

/** Converts a record id string back into a value SurrealDB parses as a record id. */
export const toSurrealRecordId = (value: unknown): unknown => {
	if (typeof value === 'string') return new StringRecordId(value);
	if (Array.isArray(value)) return value.map(toSurrealRecordId);
	if (value instanceof Set) return new Set([...value].map(toSurrealRecordId));
	return value;
};

const convertPath = (
	value: unknown,
	path: readonly string[],
	convert: (value: unknown) => unknown,
): unknown => {
	if (path[0] === '*') {
		const rest = path.slice(1);
		const convertItem = (item: unknown) => convertPath(item, rest, convert);
		if (Array.isArray(value)) return value.map(convertItem);
		if (value instanceof Set) return new Set([...value].map(convertItem));
		if (!isPlainObject(value)) return value;
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [
				key,
				convertItem(item),
			]),
		);
	}
	if (Array.isArray(value) && path.length > 0) {
		return value.map((item) => convertPath(item, path, convert));
	}
	if (value instanceof Set && path.length > 0) {
		return new Set(
			[...value].map((item) => convertPath(item, path, convert)),
		);
	}
	if (path.length === 0) return convert(value);
	if (!isPlainObject(value)) return value;
	const [head, ...rest] = path as [string, ...string[]];
	if (!(head in value)) return value;
	return { ...value, [head]: convertPath(value[head], rest, convert) };
};

const matchesFieldPattern = (
	pattern: readonly string[],
	path: readonly (string | number)[],
): boolean => {
	if (pattern.length === 0) return path.length === 0;
	const [head, ...rest] = pattern;
	if (head === '*') {
		// A query can address an array item directly or read through the array.
		return (
			matchesFieldPattern(rest, path) ||
			(path.length > 0 && matchesFieldPattern(rest, path.slice(1)))
		);
	}
	return (
		path.length > 0 &&
		String(path[0]) === head &&
		matchesFieldPattern(rest, path.slice(1))
	);
};

/** Whether a queried path is a record-link field, honoring `*` segments. */
export const isRecordFieldPath = (
	fields: ReadonlySet<string>,
	path: readonly (string | number)[],
): boolean => {
	if (fields.has(path.join('.'))) return true;
	for (const field of fields) {
		if (
			field.includes('*') &&
			matchesFieldPattern(field.split('.'), path)
		) {
			return true;
		}
	}
	return false;
};

/**
 * Converts the configured record-link fields (dot paths) of a row from
 * strings to record ids before the row is sent to SurrealDB.
 */
export const recordFieldsToSurreal = <T extends Record<string, unknown>>(
	row: T,
	recordFields: readonly string[],
): T => {
	let out: unknown = row;
	for (const field of recordFields) {
		out = convertPath(out, field.split('.'), toSurrealRecordId);
	}
	return out as T;
};
