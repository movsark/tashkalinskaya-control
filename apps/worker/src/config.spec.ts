import { describe, expect, it } from "vitest";

import { loadWorkerConfig } from "./config";

describe("loadWorkerConfig", () => {
  it("uses a bounded polling interval", () => {
    expect(loadWorkerConfig({}).pollIntervalMs).toBe(5000);
    expect(() => loadWorkerConfig({ WORKER_POLL_INTERVAL_MS: "10" })).toThrow();
  });

  it("requires complete VAPID settings", () => {
    expect(() => loadWorkerConfig({ PUSH_VAPID_PUBLIC_KEY: "public-key-at-least-twenty" })).toThrow(
      "required together",
    );
  });

  it("requires a database URL when the database is mandatory", () => {
    expect(() => loadWorkerConfig({ DATABASE_REQUIRED: "true" })).toThrow("DATABASE_URL");
  });
});
