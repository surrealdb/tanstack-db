import { describe, expect, it } from 'bun:test';
import { SingleProcessCoordinator } from '@tanstack/db-sqlite-persistence-core';
import { createCollection } from '@tanstack/db';
import { QueryClient } from '@tanstack/query-core';
import { RecordId } from 'surrealdb';

import { persistedSurrealCollectionOptions } from '../src/index';

type Item = { id: RecordId<'item'>; rank: number };
type Message = { action: string; value?: Record<string, unknown> };

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

const setup = async () => {
	let storage: Promise<void> = Promise.resolve();
	const emitters: Array<(message: Message) => void> = [];
	const errors: unknown[] = [];
	const live = () => {
		const subscription = {
			subscribe: (next: (message: Message) => void) => {
				emitters.push(next);
			},
			kill: async () => {},
		};
		return {
			where: async () => subscription,
			then: (resolve: (value: typeof subscription) => unknown) =>
				Promise.resolve(subscription).then(resolve),
		};
	};
	const items = createCollection(
		persistedSurrealCollectionOptions<Item>({
			db: {
				isFeatureSupported: () => true,
				query: async () => [[]],
				live,
			} as never,
			table: { name: 'item' },
			queryClient: new QueryClient(),
			queryKey: ['item', crypto.randomUUID()],
			syncMode: 'on-demand',
			onError: (error: unknown) => errors.push(error),
			schemaVersion: 1,
			persistence: {
				adapter: {
					loadSubset: async () => [],
					loadResumeSnapshot: async () => ({
						rows: [],
						collectionMetadata: [],
						latestTerm: 0,
						latestSeq: 0,
						latestRowVersion: 0,
						resetEpoch: 0,
					}),
					applyCommittedTx: () => storage,
					ensureIndex: async () => undefined,
				},
				coordinator: new SingleProcessCoordinator('test-node'),
			},
		}),
	);
	items.startSyncImmediate();
	await tick();
	const block = () => {
		let release = () => {};
		storage = new Promise<void>((resolve) => {
			release = resolve;
		});
		return () => {
			storage = Promise.resolve();
			release();
		};
	};
	return { items, emitters, errors, block };
};

describe('live subsets with queued persistence writes', () => {
	it('emits nothing for a delete of an unknown row', async () => {
		const { items, emitters, errors } = await setup();
		await items._sync.loadSubset({});
		await tick();
		const changes: unknown[] = [];
		const subscription = items.subscribeChanges((batch) => {
			changes.push(...batch);
		});

		emitters[0]?.({
			action: 'DELETE',
			value: { id: new RecordId('item', 'unknown'), rank: 1 },
		});
		await tick();
		subscription.unsubscribe();

		expect(errors).toEqual([]);
		expect(changes).toEqual([]);
	});

	it('applies a LIVE delete for a row still queued', async () => {
		const { items, emitters, errors, block } = await setup();
		await items._sync.loadSubset({ limit: 10 });
		await items._sync.loadSubset({ limit: 20 });
		await items._sync.loadSubset({ limit: 30 });
		await tick();

		// The first write holds storage, so the second waits outside core.
		const release = block();
		emitters[0]?.({
			action: 'CREATE',
			value: { id: new RecordId('item', 'first'), rank: 1 },
		});
		await tick();
		emitters[1]?.({
			action: 'CREATE',
			value: { id: new RecordId('item', 'queued'), rank: 2 },
		});
		await tick();
		expect(items.has('item:queued')).toBe(false);

		emitters[2]?.({
			action: 'DELETE',
			value: { id: new RecordId('item', 'queued'), rank: 2 },
		});
		await tick();
		release();
		await tick();
		await tick();

		expect(errors).toEqual([]);
		expect(items.has('item:first')).toBe(true);
		expect(items.has('item:queued')).toBe(false);
	});
});
