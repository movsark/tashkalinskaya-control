import { describe, expect, it, vi } from "vitest";

import { AuthService } from "./auth.service";
import type { DeviceSecurityRepository } from "./device-security.repository";
import type { IdentityCryptoService } from "./identity-crypto.service";
import type { IdentityRepository, NewSession } from "./identity.repository";
import type { SmsRuService } from "./sms-ru.service";
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
      { available: false } as SmsRuService,
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
    expect(expiresAt - before).toBeLessThanOrEqual(365 * 24 * 60 * 60 * 1000 + 100);
    expect((createdSession as NewSession | null)?.refreshExpiresAt).toBeNull();
  });

  it("registers an invited employee without WebAuthn and creates a persistent session", async () => {
    const invitationId = "10000000-0000-4000-8000-000000000010";
    const webauthn = { verifyRegistration: vi.fn() };
    const repository = {
      findEmployeeInvitation: vi.fn().mockResolvedValue({
        expiresAt: new Date("2026-08-04T10:00:00.000Z"),
        id: invitationId,
        roleCode: "ATTENDANCE_ONLY",
        roleDisplayName: "Только табель",
        scopeDisplayName: null,
        scopeId: null,
        scopeType: "FACTORY",
      }),
      getEmployee: vi.fn().mockResolvedValue({
        accountStatus: "ACTIVE",
        departmentId: null,
        employmentStatus: "ACTIVE",
        fullName: "Иванова Марина",
        id: employeeId,
        login: "marina.ivanova",
        personnelNumber: "QR-TEST",
        roles: [
          {
            id: "10000000-0000-4000-8000-000000000011",
            roleCode: "ATTENDANCE_ONLY",
            scopeId: null,
            scopeType: "FACTORY",
          },
        ],
        version: 1,
      }),
      registerEmployeeFromInvitation: vi.fn(),
    };
    const crypto = {
      createCsrfToken: vi.fn().mockReturnValue("csrf"),
      generateSessionToken: vi.fn().mockReturnValue("session-token"),
      hashAccessCode: vi.fn().mockReturnValue("invitation-hash"),
      hashPassword: vi.fn().mockResolvedValue("password-hash"),
      hashSessionToken: vi.fn().mockReturnValue("session-hash"),
      normalizeLogin: vi.fn().mockReturnValue("marina.ivanova"),
    };
    const service = new AuthService(
      crypto as unknown as IdentityCryptoService,
      {} as DeviceSecurityRepository,
      repository as unknown as IdentityRepository,
      { available: false } as SmsRuService,
      webauthn as unknown as WebAuthnService,
    );

    const result = await service.registerEmployee(
      {
        deviceId,
        firstName: "Марина",
        invitationCode: "one-time-invitation-code",
        lastName: "Иванова",
        login: "Marina.Ivanova",
        password: "торт-2026",
        platformFamily: "ANDROID",
      },
      "10000000-0000-4000-8000-000000000012",
    );

    expect(result.body).toMatchObject({ deviceId, employee: { fullName: "Иванова Марина" } });
    expect(repository.registerEmployeeFromInvitation).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId,
        fullName: "Иванова Марина",
        invitationId,
        loginNormalized: "marina.ivanova",
        platformFamily: "ANDROID",
      }),
    );
    expect(webauthn.verifyRegistration).not.toHaveBeenCalled();
  });
});

describe("AuthService account self-service", () => {
  const actor = {
    accountId,
    deviceId,
    employee: {
      accountStatus: "ACTIVE",
      departmentId: null,
      employmentStatus: "ACTIVE",
      fullName: "Администратор",
      id: employeeId,
      login: "admin",
      personnelNumber: "A-01",
      roles: [],
      version: 1,
    },
    roles: [],
    sessionExpiresAt: new Date("2026-08-06T00:00:00.000Z"),
    sessionId: "10000000-0000-4000-8000-000000000006",
    sessionToken: "session-token",
    stepUpExpiresAt: null,
  } as const;

  it("returns only a masked verified phone", async () => {
    const repository = {
      getAccountProfile: vi.fn().mockResolvedValue({
        fullName: "Администратор",
        login: "admin",
        phoneE164: "+79001234567",
        phoneVerified: true,
      }),
    };
    const service = new AuthService(
      {} as IdentityCryptoService,
      {} as DeviceSecurityRepository,
      repository as unknown as IdentityRepository,
      { available: true } as SmsRuService,
      {} as WebAuthnService,
    );

    await expect(service.accountProfile(actor)).resolves.toEqual({
      fullName: "Администратор",
      login: "admin",
      phoneMasked: "+7 ••• •••-45-67",
      phoneVerified: true,
      smsRecoveryAvailable: true,
    });
  });

  it("changes the password only after checking the current password", async () => {
    const repository = {
      changePassword: vi.fn(),
      findAccountByLogin: vi.fn().mockResolvedValue({
        accountId,
        passwordHash: "stored-hash",
      }),
    };
    const crypto = {
      hashPassword: vi.fn().mockResolvedValue("new-hash"),
      verifyPassword: vi.fn().mockResolvedValue(true),
    };
    const service = new AuthService(
      crypto as unknown as IdentityCryptoService,
      {} as DeviceSecurityRepository,
      repository as unknown as IdentityRepository,
      { available: false } as SmsRuService,
      {} as WebAuthnService,
    );

    await service.changePassword(
      { currentPassword: "старый-пароль", newPassword: "новый-пароль" },
      actor,
      "10000000-0000-4000-8000-000000000007",
    );

    expect(crypto.verifyPassword).toHaveBeenCalledWith("stored-hash", "старый-пароль");
    expect(repository.changePassword).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId,
        employeeId,
        passwordHash: "new-hash",
        sessionId: actor.sessionId,
      }),
    );
  });
});
