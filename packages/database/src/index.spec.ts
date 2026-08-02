import { describe, expect, it } from "vitest";

import { createDatabasePool, isDatabaseConfigured } from "./index";

describe("isDatabaseConfigured", () => {
  it("rejects an absent or blank database URL", () => {
    expect(isDatabaseConfigured(undefined)).toBe(false);
    expect(isDatabaseConfigured("  ")).toBe(false);
  });

  it("accepts a non-empty database URL", () => {
    expect(isDatabaseConfigured("postgresql://localhost/factory")).toBe(true);
  });
});

describe("createDatabasePool", () => {
  it("keeps certificate verification for a pinned Timeweb certificate", async () => {
    const pool = createDatabasePool({
      applicationName: "database-test",
      connectionString: "postgresql://localhost/factory",
      sslMode: "require",
    });

    expect(pool.options.ssl).toMatchObject({ rejectUnauthorized: true });
    expect(typeof (pool.options.ssl as { checkServerIdentity?: unknown }).checkServerIdentity).toBe(
      "function",
    );

    await pool.end();
  });
});
