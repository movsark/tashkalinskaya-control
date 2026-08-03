import { describe, expect, it, vi } from "vitest";

import { AuthService } from "./auth.service";
import type { DeviceSecurityRepository } from "./device-security.repository";
import type { IdentityCryptoService } from "./identity-crypto.service";
import type { IdentityRepository, NewSession } from "./identity.repository";
import type { WebAuthnService } from "./webauthn.service";

const accountId = "10000000-0000-4000-8000-000000000001";
const employeeId = "10000000-0000-4000-8000-000000000002";
const deviceId = "10000000-0000-4000-8000-000000000003";

describe("AuthService simple personal login", () => {
  it("creates a one-year session from login, password and the bound device", async () => {
    let createdSession: NewSession | null = null;
    const webauthn = { verifyAuthentication: vi.fn() };
    const repository = {
      clearLoginBucket: vi.fn(),
      createLoginSession: vi.fn((input: { session: NewSession }) => {
        createdSession = input.session;
      }),
      findAccountByLogin: vi.fn().mockResolvedValue({
        accountId,
        accountStatus: "ACTIVE",
        authorizationVersion: 4,
        employeeId,
        employeeStatus: "ACTIVE",
        lockedUntil: null,
        passwordHash: "stored-hash",
      }),
      findActiveDevice: vi.fn().mockResolvedValue({
        employeeId,
        id: deviceId,
        platformFamily: "IOS",
        status: "ACTIVE",
        webauthnBackedUp: false,
        webauthnCounter: 0,
        webauthnCredentialId: "legacy-credential",
        webauthnDeviceType: "singleDevice",
        webauthnPublicKey: Buffer.from("legacy"),
        webauthnTransports: [],
      }),
      getEmployee: vi.fn().mockResolvedValue({
        accountStatus: "ACTIVE",
        departmentId: null,
        employmentStatus: "ACTIVE",
        fullName: "Администратор",
        id: employeeId,
        login: "admin",
        personnelNumber: "A-01",
        roles: [
          {
            id: "10000000-0000-4000-8000-000000000004",
            roleCode: "ADMIN",
            scopeId: null,
            scopeType: "FACTORY",
          },
        ],
        version: 1,
      }),
      isLoginBucketBlocked: vi.fn().mockResolvedValue(false),
    };
    const crypto = {
      createCsrfToken: vi.fn().mockReturnValue("csrf"),
      generateSessionToken: vi.fn().mockReturnValue("session-token"),
      hashRateLimitBucket: vi.fn().mockReturnValue("rate-bucket"),
      hashSessionToken: vi.fn().mockReturnValue("session-hash"),
      normalizeLogin: vi.fn().mockReturnValue("admin"),
      verifyPassword: vi.fn().mockResolvedValue(true),
    };
    const service = new AuthService(
      crypto as unknown as IdentityCryptoService,
      {} as DeviceSecurityRepository,
      repository as unknown as IdentityRepository,
      webauthn as unknown as WebAuthnService,
    );

    const before = Date.now();
    const result = await service.login(
      { deviceId, login: "admin", password: "торт2026" },
      "10000000-0000-4000-8000-000000000005",
      "127.0.0.1",
    );

    expect(result.body).toMatchObject({ deviceId, sessionExpiresAt: expect.any(String) });
    expect(repository.findActiveDevice).toHaveBeenCalledWith(deviceId);
    expect(webauthn.verifyAuthentication).not.toHaveBeenCalled();
    expect(createdSession).not.toBeNull();
    const expiresAt = (createdSession as NewSession | null)?.accessExpiresAt.getTime() ?? 0;
    expect(expiresAt - before).toBeGreaterThan(364 * 24 * 60 * 60 * 1000);
    expect(expiresAt - before).toBeLessThanOrEqual(365 * 24 * 60 * 60 * 1000);
    expect((createdSession as NewSession | null)?.refreshExpiresAt).toBeNull();
  });
});
