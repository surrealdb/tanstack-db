export class ActiveSubsetTracker {
	private readonly subsetIds = new Map<string, Set<string>>();
	readonly activeIds = new Set<string>();

	get size(): number {
		return this.subsetIds.size;
	}

	has(id: string): boolean {
		return this.activeIds.has(id);
	}

	idsOf(key: string): ReadonlySet<string> {
		return this.subsetIds.get(key) ?? new Set();
	}

	set(key: string, ids: Set<string>): void {
		this.subsetIds.set(key, ids);
		this.rebuildActiveIds();
	}

	addId(key: string, id: string): void {
		const ids = this.subsetIds.get(key);
		if (!ids) return;
		ids.add(id);
		this.activeIds.add(id);
	}

	removeId(key: string, id: string): void {
		const ids = this.subsetIds.get(key);
		if (!ids?.delete(id)) return;
		for (const other of this.subsetIds.values()) {
			if (other.has(id)) return;
		}
		this.activeIds.delete(id);
	}

	delete(key: string): void {
		this.subsetIds.delete(key);
		this.rebuildActiveIds();
	}

	deleteId(id: string): void {
		for (const ids of this.subsetIds.values()) ids.delete(id);
		this.rebuildActiveIds();
	}

	clear(): void {
		this.subsetIds.clear();
		this.rebuildActiveIds();
	}

	private rebuildActiveIds(): void {
		this.activeIds.clear();
		for (const ids of this.subsetIds.values()) {
			for (const id of ids) this.activeIds.add(id);
		}
	}
}
