import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createCollection, createLiveQueryCollection } from '@tanstack/db';
import { QueryClient } from '@tanstack/query-core';
import { RecordId } from 'surrealdb';

import { surrealCollectionOptions } from '../src/index';

type Thing = { id: RecordId<'thing'>; name: string };
type LiveMessage = { action: string; value: { id: RecordId } };

const rows = () => [{ id: new RecordId('thing', 'a'), name: 'A' }];

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

const setup = (notify: 'before-response' | 'after-response') => {
	let listener: ((message: LiveMessage) => unknown) | undefined;
	const emitDelete = (id: RecordId) =>
		listener?.({ action: 'DELETE', value: { id } });
	const db = {
		isFeatureSupported: () => true,
		select: async () => rows(),
		query: async () => [rows()],
		live: async () => ({
			subscribe: (next: (message: LiveMessage) => unknown) => {
				listener = next;
			},
			kill: async () => {},
		}),
		delete: async (id: RecordId) => {
			if (notify === 'before-response') await emitDelete(id);
		},
		update: (id: RecordId) => ({
			merge: async (payload: unknown) => {
				if (String(id) !== 'thing:a') return payload;
				if (notify === 'before-response') await emitDelete(id);
				return undefined;
			},
		}),
	};
	const things = createCollection(
		surrealCollectionOptions<Thing>({
			db: db as never,
			table: { name: 'thing' },
			queryClient: new QueryClient(),
			queryKey: ['thing', notify],
		}),
	);
	return { things, emitDelete };
};

describe('collection.delete with LIVE sync', () => {
	const unhandled: unknown[] = [];
	const onUnhandled = (error: unknown) => {
		unhandled.push(error);
	};

	beforeEach(() => {
		unhandled.length = 0;
		process.on('unhandledRejection', onUnhandled);
	});
	afterEach(() => {
		process.off('unhandledRejection', onUnhandled);
	});

	for (const notify of ['before-response', 'after-response'] as const) {
		it(`applies one delete when LIVE arrives ${notify}`, async () => {
			const { things, emitDelete } = setup(notify);
			const all = createLiveQueryCollection((q) =>
				q.from({ thing: things }),
			);
			await all.preload();
			await flush();
			expect(things.has('thing:a')).toBe(true);

			await things.delete('thing:a').when('settled');
			if (notify === 'after-response') {
				await emitDelete(new RecordId('thing', 'a'));
			}
			await flush();

			expect(things.has('thing:a')).toBe(false);
			expect(unhandled).toEqual([]);
			await all.cleanup();
			await things.cleanup();
		});
	}

	for (const notify of ['before-response', 'after-response'] as const) {
		it(`removes a row deleted on the server when LIVE arrives ${notify} a queued update`, async () => {
			const { things, emitDelete } = setup(notify);
			const all = createLiveQueryCollection((q) =>
				q.from({ thing: things }),
			);
			await all.preload();
			await flush();

			await things
				.update('thing:a', (draft) => {
					draft.name = 'Edited';
				})
				.when('settled');
			await flush();
			expect(things.has('thing:a')).toBe(false);

			if (notify === 'after-response') {
				await emitDelete(new RecordId('thing', 'a'));
				await flush();
			}

			expect(things.has('thing:a')).toBe(false);
			expect(unhandled).toEqual([]);
			await all.cleanup();
			await things.cleanup();
		});
	}
});

describe('E2EE update of a row deleted on the server', () => {
	const setupE2ee = (select: unknown[], merged: unknown) => {
		const merges: unknown[] = [];
		const db = {
			isFeatureSupported: () => false,
			select: async () => select,
			query: async () => [[]],
			update: () => ({
				merge: async (payload: unknown) => {
					merges.push(payload);
					return merged;
				},
			}),
		};
		const things = createCollection(
			surrealCollectionOptions<Thing>({
				db: db as never,
				table: { name: 'thing' },
				queryClient: new QueryClient(),
				queryKey: ['thing', crypto.randomUUID()],
				syncMode: 'on-demand',
				e2ee: {
					enabled: true,
					crypto: {
						encrypt: async () => ({
							v: 1,
							alg: 'test',
							kid: 'test',
							n: 'n',
							ct: 'ct',
						}),
						decrypt: async () => new Uint8Array(),
					} as never,
				},
			}),
		);
		things.startSyncImmediate();
		things._state.syncedData.set('thing:a', rows()[0] as Thing);
		return { things, merges };
	};

	const edit = async (things: ReturnType<typeof setupE2ee>['things']) => {
		await things
			.update('thing:a', (draft) => {
				draft.name = 'Edited';
			})
			.when('settled');
		await flush();
	};

	it('removes the row without writing when it is already gone', async () => {
		const { things, merges } = setupE2ee([], undefined);
		await edit(things);

		expect(merges).toEqual([]);
		expect(things.has('thing:a')).toBe(false);
	});

	it('removes the row when it disappears during the update', async () => {
		const { things, merges } = setupE2ee(rows(), undefined);
		await edit(things);

		expect(merges).toHaveLength(1);
		expect(things.has('thing:a')).toBe(false);
	});

	it('keeps the row when the update succeeds', async () => {
		const { things } = setupE2ee(rows(), { id: 'thing:a' });
		await edit(things);

		expect(things.has('thing:a')).toBe(true);
	});
});
