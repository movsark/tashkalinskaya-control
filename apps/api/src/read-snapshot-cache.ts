interface SnapshotEntry<Value> {
  expiresAt: number;
  readonly promise: Promise<Value>;
}

export class ReadSnapshotCache<Value> {
  private readonly entries = new Map<string, SnapshotEntry<Value>>();

  constructor(
    private readonly ttlMs = 0,
    private readonly maximumEntries = 128,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string, loader: () => Promise<Value>): Promise<Value> {
    const now = this.now();
    const existing = this.entries.get(key);
    if (existing !== undefined && existing.expiresAt > now) return existing.promise;

    const promise = Promise.resolve().then(loader);
    const entry = { expiresAt: Number.POSITIVE_INFINITY, promise };
    this.entries.set(key, entry);
    void promise.then(
      () => {
        if (this.entries.get(key) === entry) entry.expiresAt = this.now() + this.ttlMs;
      },
      () => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
      },
    );
    this.prune(now);
    return promise;
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
    while (this.entries.size > this.maximumEntries) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
    }
  }
}
