import { describe, expect, it } from "vitest";

import { loadApiConfig } from "../config";
import { IdentityCryptoService } from "./identity-crypto.service";

const service = new IdentityCryptoService(loadApiConfig({ NODE_ENV: "test" }));

describe("IdentityCryptoService", () => {
  it("hashes passwords with Argon2id and verifies them", async () => {
    const password = "длинная рабочая фраза сотрудника";
    const passwordHash = await service.hashPassword(password);

    expect(passwordHash).toContain("$argon2id$");
    await expect(service.verifyPassword(passwordHash, password)).resolves.toBe(true);
    await expect(service.verifyPassword(passwordHash, "другая длинная фраза")).resolves.toBe(false);
  });

  it("rejects short and common passwords", async () => {
    await expect(service.hashPassword("короткий")).rejects.toThrow();
    await expect(service.hashPassword("123456789012345")).rejects.toThrow();
  });

  it("never stores access and session tokens in their raw form", () => {
    const accessCode = service.generateAccessCode();
    const sessionToken = service.generateSessionToken();

    expect(service.hashAccessCode(accessCode)).not.toContain(accessCode);
    expect(service.hashSessionToken(sessionToken)).not.toContain(sessionToken);
    expect(service.verifyCsrfToken(sessionToken, service.createCsrfToken(sessionToken))).toBe(true);
    expect(service.verifyCsrfToken(sessionToken, "wrong")).toBe(false);
  });

  it("stores WebAuthn challenges only as purpose-separated HMAC hashes", () => {
    const challenge = "base64url-webauthn-challenge";

    expect(service.hashChallenge(challenge)).toHaveLength(64);
    expect(service.hashChallenge(challenge)).not.toBe(service.hashAccessCode(challenge));
    expect(service.hashChallenge(challenge)).not.toContain(challenge);
  });

  it("normalizes equivalent login forms", () => {
    expect(service.normalizeLogin("  Админ  ")).toBe("админ");
    expect(service.normalizePersonnelNumber(" т-001 ")).toBe("Т-001");
  });
});
