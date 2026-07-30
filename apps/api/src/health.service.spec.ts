import { describe, expect, it } from "vitest";

import type { ApiConfig } from "./config";
import { HealthService } from "./health.service";

const localConfig: ApiConfig = {
  appVersion: "0.1.0-test",
  corsOrigins: ["http://localhost:3000"],
  databaseRequired: false,
  databaseSsl: "disable",
  nodeEnvironment: "test",
  port: 4000,
};

describe("HealthService", () => {
  it("reports liveness without requiring external services", () => {
    const service = new HealthService(localConfig);

    expect(service.getLiveness()).toMatchObject({
      service: "api",
      state: "healthy",
      version: "0.1.0-test",
    });
  });

  it("allows an optional database in local development", async () => {
    const service = new HealthService(localConfig);

    await expect(service.getReadiness()).resolves.toMatchObject({
      checks: { database: "not_configured" },
      state: "healthy",
    });
  });
});
