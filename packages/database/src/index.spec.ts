import { createHash } from "node:crypto";

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
      connectionString: "postgresql://localhost/factory?sslmode=require",
      sslMode: "require",
    });

    expect(pool.options.connectionString).toBe("postgresql://localhost/factory");
    expect(pool.options.ssl).toMatchObject({ rejectUnauthorized: true });
    expect(typeof (pool.options.ssl as { checkServerIdentity?: unknown }).checkServerIdentity).toBe(
      "function",
    );

    await pool.end();
  });

  it("pins the exact TLS certificate for a private Timeweb endpoint", async () => {
    const rawCertificate = Buffer.from("timeweb-private-database-certificate");
    const fingerprint = createHash("sha256").update(rawCertificate).digest("hex");
    const pool = createDatabasePool({
      applicationName: "database-test",
      connectionString: "postgresql://localhost/factory",
      sslMode: "require",
      tlsFingerprintSha256: fingerprint,
    });

    expect(pool.options.ssl).toMatchObject({ rejectUnauthorized: false });
    expect(typeof pool.options.onConnect).toBe("function");
    expect(() =>
      pool.options.onConnect?.({
        connection: {
          stream: {
            encrypted: true,
            getPeerCertificate: () => ({ raw: rawCertificate }),
          },
        },
      } as never),
    ).not.toThrow();

    await pool.end();
  });

  it("rejects a changed TLS certificate", async () => {
    const pool = createDatabasePool({
      applicationName: "database-test",
      connectionString: "postgresql://localhost/factory",
      sslMode: "require",
      tlsFingerprintSha256: "00".repeat(32),
    });

    expect(() =>
      pool.options.onConnect?.({
        connection: {
          stream: {
            encrypted: true,
            getPeerCertificate: () => ({ raw: Buffer.from("unexpected-certificate") }),
          },
        },
      } as never),
    ).toThrow("fingerprint does not match");

    await pool.end();
  });

  it("rejects a malformed TLS certificate fingerprint", () => {
    expect(() =>
      createDatabasePool({
        applicationName: "database-test",
        connectionString: "postgresql://localhost/factory",
        sslMode: "require",
        tlsFingerprintSha256: "not-a-fingerprint",
      }),
    ).toThrow("valid SHA-256");
  });
});
