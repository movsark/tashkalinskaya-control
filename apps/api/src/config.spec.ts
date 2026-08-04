import { describe, expect, it } from "vitest";

import { loadApiConfig } from "./config";

describe("loadApiConfig", () => {
  it("loads safe local defaults", () => {
    const config = loadApiConfig({});

    expect(config.authTokenPepper.length).toBeGreaterThanOrEqual(32);
    expect(config.csrfSecret.length).toBeGreaterThanOrEqual(32);
    expect(config.port).toBe(4000);
    expect(config.databaseMaxConnections).toBe(10);
    expect(config.databaseRequired).toBe(false);
    expect(config.corsOrigins).toEqual(["http://localhost:3000"]);
    expect(config.fileStorageDriver).toBe("local");
    expect(config.s3).toBeNull();
    expect(config.pushVapidPublicKey).toBeNull();
    expect(config.sessionTokenPepper.length).toBeGreaterThanOrEqual(32);
  });

  it("rejects an invalid port", () => {
    expect(() => loadApiConfig({ API_PORT: "70000" })).toThrow();
  });

  it("does not allow local identity secrets in production", () => {
    expect(() => loadApiConfig({ NODE_ENV: "production" })).toThrow("AUTH_TOKEN_PEPPER");
  });

  it("requires a complete private S3 configuration", () => {
    expect(() => loadApiConfig({ FILE_STORAGE_DRIVER: "s3" })).toThrow("S3_ENDPOINT");
  });

  it("requires a database URL when the database is mandatory", () => {
    expect(() => loadApiConfig({ DATABASE_REQUIRED: "true" })).toThrow("DATABASE_URL");
  });

  it("accepts a bounded database pool size", () => {
    expect(loadApiConfig({ DATABASE_MAX_CONNECTIONS: "20" }).databaseMaxConnections).toBe(20);
    expect(() => loadApiConfig({ DATABASE_MAX_CONNECTIONS: "0" })).toThrow();
    expect(() => loadApiConfig({ DATABASE_MAX_CONNECTIONS: "101" })).toThrow();
  });

  it("enables a digest-only read credential in staging", () => {
    const config = loadApiConfig(
      stagingEnvironment({
        STAGING_LOAD_AUTH_ENABLED: "true",
        STAGING_LOAD_LOGIN: "B20-Admin",
        STAGING_LOAD_TOKEN_SHA256: "a".repeat(64),
      }),
    );

    expect(config.stagingLoadAccess).toEqual({
      login: "b20-admin",
      tokenSha256: "a".repeat(64),
    });
  });

  it("rejects staging load access outside staging", () => {
    expect(() =>
      loadApiConfig({
        STAGING_LOAD_AUTH_ENABLED: "true",
        STAGING_LOAD_LOGIN: "b20-admin",
        STAGING_LOAD_TOKEN_SHA256: "a".repeat(64),
      }),
    ).toThrow("allowed only when NODE_ENV=staging");
  });

  it("requires a complete staging load credential", () => {
    expect(() => loadApiConfig(stagingEnvironment({ STAGING_LOAD_AUTH_ENABLED: "true" }))).toThrow(
      "STAGING_LOAD_LOGIN",
    );
  });
});

function stagingEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    AUTH_TOKEN_PEPPER: "a".repeat(32),
    CSRF_SECRET: "b".repeat(32),
    FILE_STORAGE_DRIVER: "s3",
    NODE_ENV: "staging",
    PUSH_SUBSCRIPTION_ENCRYPTION_KEY: "c".repeat(32),
    S3_ACCESS_KEY_ID: "access-key",
    S3_BUCKET: "bucket",
    S3_ENDPOINT: "https://s3.example.test",
    S3_SECRET_ACCESS_KEY: "secret-key",
    SESSION_TOKEN_PEPPER: "d".repeat(32),
    WEBAUTHN_ORIGINS: "https://staging.example.test",
    WEBAUTHN_RP_ID: "staging.example.test",
    ...overrides,
  };
}
