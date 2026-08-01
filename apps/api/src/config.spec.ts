import { describe, expect, it } from "vitest";

import { loadApiConfig } from "./config";

describe("loadApiConfig", () => {
  it("loads safe local defaults", () => {
    const config = loadApiConfig({});

    expect(config.authTokenPepper.length).toBeGreaterThanOrEqual(32);
    expect(config.csrfSecret.length).toBeGreaterThanOrEqual(32);
    expect(config.port).toBe(4000);
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
});
