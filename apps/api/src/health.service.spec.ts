import { describe, expect, it } from "vitest";

import type { ApiConfig } from "./config";
import { HealthService } from "./health.service";

const localConfig: ApiConfig = {
  appVersion: "0.1.0-test",
  authTokenPepper: "test-auth-token-pepper-32-characters",
  corsOrigins: ["http://localhost:3000"],
  csrfSecret: "test-csrf-secret-32-characters-ok",
  databaseRequired: false,
  databaseMaxConnections: 10,
  databaseSsl: "disable",
  fileStorageDriver: "local",
  fileStorageLocalDirectory: "var/test-private-files",
  localUatQuickLogin: false,
  nodeEnvironment: "test",
  port: 4000,
  pushSubscriptionEncryptionKey: "test-push-subscription-secret-32-characters",
  pushVapidPublicKey: null,
  s3: null,
  sessionTokenPepper: "test-session-pepper-32-characters",
  smsRuApiId: null,
  stagingLoadAccess: null,
  webauthnOrigins: ["http://localhost:3000"],
  webauthnRpId: "localhost",
  webauthnRpName: "Ташкалинская фабрика",
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
