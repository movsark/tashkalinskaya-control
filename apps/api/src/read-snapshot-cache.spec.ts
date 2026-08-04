import { describe, expect, it } from "vitest";

import { ReadSnapshotCache } from "./read-snapshot-cache";

describe("ReadSnapshotCache", () => {
  it("coalesces simultaneous readers of the same snapshot", async () => {
    const cache = new ReadSnapshotCache<number>();
    let calls = 0;
    const loader = async () => {
      calls += 1;
      return 42;
    };

    const first = cache.get("same", loader);
    const second = cache.get("same", loader);

    await expect(Promise.all([first, second])).resolves.toEqual([42, 42]);
    expect(calls).toBe(1);

    await expect(cache.get("same", loader)).resolves.toBe(42);
    expect(calls).toBe(2);
  });

  it("keeps a slow in-flight read coalesced beyond the freshness window", async () => {
    let now = 1_000;
    const cache = new ReadSnapshotCache<number>(250, 128, () => now);
    let resolve!: (value: number) => void;
    const pending = new Promise<number>((done) => {
      resolve = done;
    });
    let calls = 0;
    const first = cache.get("same", () => {
      calls += 1;
      return pending;
    });

    now += 1_000;
    const second = cache.get("same", () => {
      calls += 1;
      return Promise.resolve(2);
    });
    resolve(1);

    await expect(Promise.all([first, second])).resolves.toEqual([1, 1]);
    expect(calls).toBe(1);
  });

  it("reloads a snapshot after the short freshness window", async () => {
    let now = 1_000;
    const cache = new ReadSnapshotCache<number>(250, 128, () => now);
    let value = 1;

    await expect(cache.get("same", async () => value)).resolves.toBe(1);
    value = 2;
    now += 249;
    await expect(cache.get("same", async () => value)).resolves.toBe(1);
    now += 1;
    await expect(cache.get("same", async () => value)).resolves.toBe(2);
  });

  it("does not retain a failed read", async () => {
    const cache = new ReadSnapshotCache<number>();
    let calls = 0;
    await expect(
      cache.get("same", async () => {
        calls += 1;
        throw new Error("database unavailable");
      }),
    ).rejects.toThrow("database unavailable");

    await expect(
      cache.get("same", async () => {
        calls += 1;
        return 7;
      }),
    ).resolves.toBe(7);
    expect(calls).toBe(2);
  });
});
