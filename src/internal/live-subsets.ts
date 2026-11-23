import {
	compileSingleRowExpression,
	type LoadSubsetOptions,
	toBooleanPredicate,
} from '@tanstack/db';
import {
	type Expr,
	Features,
	type RecordId,
	type Surreal,
	Table,
} from 'surrealdb';
import { toRecordKeyString } from '../id';
import {
	buildLiveCondition,
	readFieldPath,
	subsetOrderOf,
	windowBoundaryOf,
} from '../table';
import type { TableOptions } from '../types';
import { subsetCacheKey } from './subset-identity';
import type { ActiveSubsetTracker } from './subset-tracker';

type Row = Record<string, unknown>;

type WhereExpression = NonNullable<LoadSubsetOptions['where']>;

type LiveMessageLike = {
	action: 'CREATE' | 'UPDATE' | 'DELETE' | 'KILLED';
	value?: Row;
};

type LiveSubscriptionLike = {
	subscribe: (cb: (msg: LiveMessageLike) => void) => unknown;
	kill: () => Promise<void>;
};

type LiveBuilderLike = PromiseLike<LiveSubscriptionLike> & {
	where: (expr: Expr) => PromiseLike<LiveSubscriptionLike>;
};

type ConnectionEvents = {
	subscribe?: (
		event: string,
		listener: (payload?: unknown) => void,
	) => () => void;
};

type Entry = {
	key: string;
	options: LoadSubsetOptions;
	refs: number;
	closed: boolean;
	failed: boolean;
	generation: number;
	lives: LiveSubscriptionLike[];
	loading: boolean;
	buffer: LiveMessageLike[];
	chain: Promise<void>;
	ready: Promise<void>;
	matches: (row: unknown) => boolean;
	surelyMatches: (row: unknown) => boolean;
};

export type LiveSubsetsConfig<T extends { id: string | RecordId }> = {
	db: Surreal;
	table: TableOptions;
	tracker: ActiveSubsetTracker;
	loadRows: (subset: LoadSubsetOptions) => Promise<Row[]>;
	decode: (row: Row) => Promise<T>;
	writeRows: (rows: T[]) => Promise<void>;
	evict: (ids: string[]) => Promise<void>;
	syncedRows: () => Iterable<T>;
	invalidate: () => void;
	onError?: (error: unknown) => void;
};

const compileMatcher = (
	options: LoadSubsetOptions,
	whenUnknown: boolean,
): ((row: unknown) => boolean) => {
	const exprs = [options.where, options.cursor?.whereFrom].filter(
		(expr): expr is WhereExpression => Boolean(expr),
	);
	if (!exprs.length) return () => true;
	try {
		const evaluators = exprs.map((expr) =>
			compileSingleRowExpression(expr),
		);
		return (row) => {
			try {
				return evaluators.every((evaluate) =>
					toBooleanPredicate(evaluate(row as Row)),
				);
			} catch {
				return whenUnknown;
			}
		};
	} catch {
		return () => whenUnknown;
	}
};

const comparable = (value: unknown): string | number | bigint | undefined => {
	if (value instanceof Date) return value.getTime();
	return typeof value === 'string' ||
		typeof value === 'number' ||
		typeof value === 'bigint'
		? value
		: undefined;
};

const isBeforeBoundary = (
	value: unknown,
	boundary: unknown,
	direction: 'asc' | 'desc',
): boolean => {
	const a = comparable(value);
	const b = comparable(boundary);
	if (a === undefined || b === undefined || typeof a !== typeof b) {
		return false;
	}
	return direction === 'asc' ? a < b : a > b;
};

export function createLiveSubsets<T extends { id: string | RecordId }>(
	config: LiveSubsetsConfig<T>,
) {
	const {
		db,
		table,
		tracker,
		loadRows,
		decode,
		writeRows,
		evict,
		syncedRows,
	} = config;
	const tableResource = new Table(table.name);
	const entries = new Map<string, Entry>();
	const report = (error: unknown) => config.onError?.(error);

	const liveSupported = async (): Promise<boolean> => {
		try {
			// Feature support is unknown until the connection is ready.
			await (db as unknown as { ready?: Promise<void> }).ready;
			return db.isFeatureSupported?.(Features.LiveQueries) === true;
		} catch {
			return false;
		}
	};

	const released = new WeakSet<LiveSubscriptionLike>();
	let signedOut = false;
	let currentAccess: string | undefined;

	const release = (lives: LiveSubscriptionLike[]) => {
		for (const live of lives) {
			released.add(live);
			void live.kill().catch(() => undefined);
		}
	};

	const enqueue = (entry: Entry, task: () => Promise<void>) => {
		const run = entry.chain.then(task);
		entry.chain = run.catch(() => undefined);
		return run;
	};

	const handle = async (entry: Entry, message: LiveMessageLike) => {
		if (entry.closed) return;
		const raw = message.value;
		if (!raw || raw.id === undefined) return;
		const id = toRecordKeyString(raw.id as string | RecordId);

		if (message.action === 'DELETE') {
			tracker.deleteId(id);
			await evict([id]);
			return;
		}

		const row = await decode(raw);
		if (entry.closed) return;
		if (entry.matches(row)) {
			tracker.addId(entry.key, id);
			await writeRows([row]);
			return;
		}

		tracker.removeId(entry.key, id);
		if (tracker.has(id)) await writeRows([row]);
		else await evict([id]);
	};

	const receive =
		(entry: Entry, live: LiveSubscriptionLike) =>
		(message: LiveMessageLike) => {
			if (entry.closed || released.has(live)) return;
			if (message.action === 'KILLED') return;
			if (entry.loading) {
				entry.buffer.push(message);
				return;
			}
			void enqueue(entry, () => handle(entry, message)).catch(report);
		};

	const flush = (entry: Entry) => {
		entry.loading = false;
		for (const message of entry.buffer.splice(0)) {
			void enqueue(entry, () => handle(entry, message)).catch(report);
		}
	};

	const openLive = async (
		entry: Entry,
		condition: Expr | undefined,
	): Promise<LiveSubscriptionLike | undefined> => {
		const builder = db.live(tableResource) as unknown as LiveBuilderLike;
		const live = await (condition ? builder.where(condition) : builder);
		if (entry.closed) {
			release([live]);
			return undefined;
		}
		live.subscribe(receive(entry, live));
		return live;
	};

	// Cached rows inside the fetched range that the server no longer returned.
	const missingFromSnapshot = (entry: Entry, rows: T[]): string[] => {
		const { limit, offset } = entry.options;
		if (offset || signedOut) return [];
		const isFullWindow = typeof limit === 'number' && rows.length >= limit;
		const leading = subsetOrderOf(table, entry.options)[0];
		const last = rows[rows.length - 1];
		if (isFullWindow && (!leading || !last)) return [];

		const inRange = (row: T) =>
			!isFullWindow ||
			isBeforeBoundary(
				readFieldPath(row, leading?.field ?? []),
				readFieldPath(last, leading?.field ?? []),
				leading?.direction ?? 'asc',
			);
		const missing: string[] = [];
		for (const row of syncedRows()) {
			const id = toRecordKeyString(row.id);
			if (!tracker.has(id) && entry.surelyMatches(row) && inRange(row)) {
				missing.push(id);
			}
		}
		return missing;
	};

	const applySnapshot = async (
		entry: Entry,
		raws: Row[],
		stale: () => boolean,
	) => {
		if (stale()) return;
		const rows = await Promise.all(raws.map((raw) => decode(raw)));
		if (stale()) return;

		const previous = [...tracker.idsOf(entry.key)];
		const ids = new Set(rows.map((row) => toRecordKeyString(row.id)));
		// Without a session a result can't prove a row is gone, but it can still
		// hold public rows. Merge it, and let the resync on sign-in reconcile.
		const authoritative = !signedOut;
		if (!authoritative) for (const id of previous) ids.add(id);
		tracker.set(entry.key, ids);
		await writeRows(rows);
		if (!authoritative) return;

		const dropped = new Set([
			...previous.filter((id) => !tracker.has(id)),
			...(stale() ? [] : missingFromSnapshot(entry, rows)),
		]);
		if (dropped.size) await evict([...dropped]);
	};

	const sync = async (entry: Entry): Promise<void> => {
		const generation = ++entry.generation;
		const stale = () => entry.closed || generation !== entry.generation;
		const previous = entry.lives;
		const opened: LiveSubscriptionLike[] = [];
		// A superseded load settles with the sync that replaced it.
		const abandon = (): Promise<void> | undefined => {
			release(opened.splice(0));
			return entry.closed ? undefined : entry.ready;
		};
		entry.failed = false;
		entry.loading = true;

		try {
			const live = (await liveSupported())
				? await openLive(
						entry,
						buildLiveCondition(table, entry.options),
					)
				: undefined;
			if (live) opened.push(live);
			if (stale()) return abandon();

			const rows = await loadRows(entry.options);
			if (stale()) return abandon();
			await enqueue(entry, () => applySnapshot(entry, rows, stale));

			const boundary = windowBoundaryOf(table, entry.options, rows);
			if (live && boundary) {
				const bounded = await openLive(
					entry,
					buildLiveCondition(table, entry.options, boundary),
				);
				if (bounded) {
					opened.push(bounded);
					release(opened.splice(0, 1));
				}
			}
			if (stale()) return abandon();

			entry.lives = opened.splice(0);
			release(previous);
		} catch (error) {
			release(opened.splice(0));
			if (generation !== entry.generation && !entry.closed) {
				return entry.ready;
			}
			if (generation === entry.generation) entry.failed = true;
			throw error;
		} finally {
			if (generation === entry.generation) flush(entry);
		}
	};

	const load = async (options: LoadSubsetOptions): Promise<void> => {
		const key = subsetCacheKey(options);
		const existing = entries.get(key);
		if (existing) {
			// Every acquisition, refetches included, gets its own unload.
			existing.refs += 1;
			if (options.refetch || existing.failed) {
				existing.ready = sync(existing);
			}
			return existing.ready;
		}

		const entry: Entry = {
			key,
			options,
			refs: 1,
			closed: false,
			failed: false,
			generation: 0,
			lives: [],
			loading: false,
			buffer: [],
			chain: Promise.resolve(),
			ready: Promise.resolve(),
			matches: compileMatcher(options, true),
			surelyMatches: compileMatcher(options, false),
		};
		entries.set(key, entry);
		tracker.set(key, new Set());
		entry.ready = sync(entry);
		return entry.ready;
	};

	const unload = (options: LoadSubsetOptions): void => {
		const key = subsetCacheKey(options);
		const entry = entries.get(key);
		if (!entry) return;
		entry.refs -= 1;
		if (entry.refs > 0) return;

		entries.delete(key);
		entry.closed = true;
		entry.buffer.length = 0;
		release(entry.lives.splice(0));
		// Keep the rows so a remount renders at once. Its snapshot reconciles them.
		tracker.delete(key);
	};

	const resync = async (): Promise<void> => {
		const active = [...entries.values()];
		if (!active.length) return;
		await Promise.all(
			active.map((entry) => {
				entry.ready = sync(entry);
				return entry.ready.catch(report);
			}),
		);
		config.invalidate();
	};

	const unsubscribers: Array<() => void> = [];
	const events = db as unknown as ConnectionEvents;
	if (typeof events.subscribe === 'function') {
		let dropped = false;
		const markDropped = () => {
			dropped = true;
		};
		unsubscribers.push(
			events.subscribe('reconnecting', markDropped),
			events.subscribe('disconnected', markDropped),
			events.subscribe('connected', () => {
				if (!dropped) return;
				dropped = false;
				void resync().catch(report);
			}),
			// LIVE queries keep the token they started with, so a new token must reopen them.
			events.subscribe('auth', (tokens) => {
				const access = (
					tokens as { access?: string } | null | undefined
				)?.access;
				const renewed = Boolean(tokens) && access !== currentAccess;
				currentAccess = access;
				signedOut = !tokens;
				if (renewed) void resync().catch(report);
			}),
		);
	}

	const cleanup = (): void => {
		for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
		for (const entry of entries.values()) {
			entry.closed = true;
			entry.buffer.length = 0;
			release(entry.lives.splice(0));
			tracker.delete(entry.key);
		}
		entries.clear();
	};

	return { load, unload, resync, cleanup };
}
