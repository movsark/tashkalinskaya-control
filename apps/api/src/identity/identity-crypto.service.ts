import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { Algorithm, hash, verify } from "@node-rs/argon2";

import { API_CONFIG, type ApiConfig } from "../config";

const COMMON_PASSWORDS = new Set([
  "password",
  "passwordpassword",
  "qwerty12",
  "qwertyqwertyqwerty",
  "12345678",
  "123456789012345",
  "пароль123",
  "парольпарольпароль",
  "ташкалинская",
]);

@Injectable()
export class IdentityCryptoService {
  private readonly dummyPasswordHashPromise = hash("not-a-real-user-password", {
    algorithm: Algorithm.Argon2id,
    memoryCost: 65_536,
    outputLen: 32,
    parallelism: 1,
    timeCost: 3,
  });

  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {}

  normalizeLogin(value: string): string {
    return value.normalize("NFKC").trim().toLocaleLowerCase("ru-RU");
  }

  normalizePersonnelNumber(value: string): string {
    return value.normalize("NFKC").trim().toLocaleUpperCase("ru-RU");
  }

  validatePassword(password: string): void {
    if (password.length < 8 || password.length > 128) {
      throw new BadRequestException({
        code: "PASSWORD_POLICY",
        message: "Парольная фраза должна содержать от 8 до 128 символов",
      });
    }

    const normalized = password.normalize("NFKC").toLocaleLowerCase("ru-RU");
    if (COMMON_PASSWORDS.has(normalized) || /^(.)\1{7,}$/u.test(normalized)) {
      throw new BadRequestException({
        code: "PASSWORD_COMPROMISED",
        message: "Выберите менее распространенную парольную фразу",
      });
    }
  }

  async hashPassword(password: string): Promise<string> {
    this.validatePassword(password);
    return hash(password, {
      algorithm: Algorithm.Argon2id,
      memoryCost: 65_536,
      outputLen: 32,
      parallelism: 1,
      timeCost: 3,
    });
  }

  async verifyPassword(passwordHash: string | null, password: string): Promise<boolean> {
    const candidateHash = passwordHash ?? (await this.dummyPasswordHashPromise);
    const valid = await verify(candidateHash, password).catch(() => false);
    return passwordHash === null ? false : valid;
  }

  generateAccessCode(): string {
    return randomBytes(20).toString("base64url");
  }

  generatePhoneCode(): string {
    return randomInt(0, 1_000_000).toString().padStart(6, "0");
  }

  hashAccessCode(code: string): string {
    return createHmac("sha256", this.config.authTokenPepper).update(code, "utf8").digest("hex");
  }

  hashChallenge(challenge: string): string {
    return createHmac("sha256", this.config.authTokenPepper)
      .update(`webauthn\u0000${challenge}`, "utf8")
      .digest("hex");
  }

  generateSessionToken(): string {
    return randomBytes(32).toString("base64url");
  }

  hashSessionToken(token: string): string {
    return createHmac("sha256", this.config.sessionTokenPepper).update(token, "utf8").digest("hex");
  }

  createCsrfToken(sessionToken: string): string {
    return createHmac("sha256", this.config.csrfSecret)
      .update(sessionToken, "utf8")
      .digest("base64url");
  }

  verifyCsrfToken(sessionToken: string, candidate: string): boolean {
    const expected = this.createCsrfToken(sessionToken);
    const expectedBuffer = Buffer.from(expected);
    const candidateBuffer = Buffer.from(candidate);
    return (
      expectedBuffer.length === candidateBuffer.length &&
      timingSafeEqual(expectedBuffer, candidateBuffer)
    );
  }

  hashRateLimitBucket(source: string, login: string): string {
    return createHash("sha256")
      .update(`${source}\u0000${this.normalizeLogin(login)}`, "utf8")
      .digest("hex");
  }
}
