import { describe, expect, it } from "vitest";

import { loadWorkerConfig } from "./config";

describe("loadWorkerConfig", () => {
  it("uses a bounded polling interval", () => {
    expect(loadWorkerConfig({}).pollIntervalMs).toBe(5000);
    expect(() => loadWorkerConfig({ WORKER_POLL_INTERVAL_MS: "10" })).toThrow();
  });
});
