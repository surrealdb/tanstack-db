import type { PersistedCollectionPersistence } from '@tanstack/db-sqlite-persistence-core';
import type { RecordId, Value } from 'surrealdb';
import type { SurrealSchemaTable } from '../schema';
import type { SurrealCollectionOptions } from '../types';

// biome-ignore lint/suspicious/noExplicitAny: matches every RecordId instantiation.
type AnyRecordId = RecordId<any, any, any>;

type OpaqueValue =
	| Value
	| Date
	| ArrayBuffer
	| ArrayBufferView
	| Map<unknown, unknown>
	| ((...args: never[]) => unknown);

/** `T` with every `RecordId`, at any depth, replaced by its string form. */
export type StringRecordIds<T> = T extends AnyRecordId
	? string
	: T extends OpaqueValue
		? T
		: T extends ReadonlySet<infer Item>
			? Set<StringRecordIds<Item>>
			: T extends readonly (infer Item)[]
				? StringRecordIds<Item>[]
				: T extends object
					? { [K in keyof T]: StringRecordIds<T[K]> }
					: T;

type Decrement = [never, 0, 1, 2, 3, 4];

type RecordPathsOf<V, Path extends string, Depth extends number> = [
	Depth,
] extends [never]
	? never
	: V extends AnyRecordId
		? Path
		: V extends OpaqueValue
			? never
			: V extends ReadonlySet<infer Item>
				? RecordPathsOf<Item, Path, Depth>
				: V extends readonly (infer Item)[]
					? RecordPathsOf<Item, Path, Depth>
					: V extends object
						? {
								[K in keyof V & string]-?: RecordPathsOf<
									V[K],
									`${Path}.${K}`,
									Decrement[Depth]
								>;
							}[keyof V & string]
						: never;

/**
 * Dot paths of the record-link fields of `T`, down to five levels. `id`, `in`
 * and `out` are left out because the adapter handles them itself.
 */
export type RecordFieldPath<T> = T extends unknown
	? {
			[K in Exclude<
				keyof T & string,
				'id' | 'in' | 'out'
			>]-?: RecordPathsOf<T[K], K, 4>;
		}[Exclude<keyof T & string, 'id' | 'in' | 'out'>]
	: never;

/** Requires SurrealKit's `tables` when `T` has record-link fields. */
export type RequiredSchemaTables<T> = [RecordFieldPath<T>] extends [never]
	? { tables?: readonly SurrealSchemaTable[] }
	: { tables: readonly SurrealSchemaTable[] };

/** The row TanStack DB sees for `T` in `recordIds: 'string'` mode. */
export type StringRecordRow<T> = StringRecordIds<T> & {
	id: string;
	sync_deleted?: boolean;
	updated_at?: Date | number | string;
};

/** Options for a row type with `RecordId` fields in `recordIds: 'string'` mode. */
export type StringRecordCollectionOptions<T extends object> = Omit<
	SurrealCollectionOptions<StringRecordRow<T>>,
	'recordIds' | 'tables'
> & { recordIds: 'string' } & RequiredSchemaTables<T>;

export type PersistedStringRecordCollectionOptions<T extends object> =
	StringRecordCollectionOptions<T> & {
		persistence: PersistedCollectionPersistence;
		schemaVersion?: number;
	};
