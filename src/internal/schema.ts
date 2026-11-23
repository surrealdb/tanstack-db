import type { StandardSchemaV1 } from '@standard-schema/spec';
import { RecordId } from 'surrealdb';
import { normalizeRecordIdLikeFields, toRecordIdString } from '../id';
import type { RecordIdMode } from '../types';
import { stringifyRecordIdsDeep, toTableRecordIdString } from './string-ids';

const TEMP_ID_PREFIX = '__temp__';

export type MutationInput<T extends { id: string | RecordId }> = Omit<
	T,
	'id'
> & {
	id?: T['id'];
};

const createTempRecordId = (tableName: string): RecordId => {
	const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
	return new RecordId(tableName, `${TEMP_ID_PREFIX}${suffix}`);
};

export const isTempId = (id: string | RecordId, tableName: string): boolean => {
	const normalized = toRecordIdString(id);
	const key = normalized.startsWith(`${tableName}:`)
		? normalized.slice(tableName.length + 1)
		: normalized;
	return key.startsWith(TEMP_ID_PREFIX);
};

export function createInsertSchema<T extends { id: string | RecordId }>(
	tableName: string,
	recordIds: RecordIdMode = 'native',
): StandardSchemaV1<MutationInput<T>, T> {
	return {
		'~standard': {
			version: 1,
			vendor: 'tanstack-db-surrealdb',
			validate: (value: unknown) => {
				if (
					!value ||
					typeof value !== 'object' ||
					Array.isArray(value)
				) {
					return {
						issues: [{ message: 'Insert data must be an object.' }],
					};
				}

				if (recordIds === 'string') {
					const data = stringifyRecordIdsDeep({
						...(value as Record<string, unknown>),
					});
					data.id = toTableRecordIdString(
						tableName,
						data.id ?? createTempRecordId(tableName),
					);
					return { value: data as T };
				}

				const data = normalizeRecordIdLikeFields({
					...(value as Record<string, unknown>),
				}) as MutationInput<T>;

				if (!data.id)
					data.id = createTempRecordId(tableName) as T['id'];

				return { value: data as T };
			},
			types: undefined,
		},
	};
}
