import { randomUUID } from "node:crypto";

import { Injectable, UnauthorizedException } from "@nestjs/common";
import type { AuthenticatedUser, EmployeeSummary } from "@tashkalinskaya/contracts";

import type { ActivateAccountDto, LoginDto } from "./identity.dto";
import { IdentityCryptoService } from "./identity-crypto.service";
import { IdentityRepository, type NewSession } from "./identity.repository";

const privilegedRoles = new Set(["ADMIN", "MANAGER", "ACCOUNTANT"]);

interface SessionResult {
  readonly body: AuthenticatedUser;
  readonly sessionToken: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly crypto: IdentityCryptoService,
    private readonly repository: IdentityRepository,
  ) {}

  async activate(dto: ActivateAccountDto, correlationId: string): Promise<SessionResult> {
    const loginNormalized = this.crypto.normalizeLogin(dto.login);
    const account = await this.repository.findAccountByLogin(loginNormalized);
    const tokenHash = this.crypto.hashAccessCode(dto.activationCode);
    const tokenValid =
      account !== null &&
      account.accountStatus === "INVITED" &&
      account.employeeStatus === "ACTIVE" &&
      (await this.repository.findValidAccessToken(account.accountId, "ACTIVATION", tokenHash));

    if (!tokenValid || account === null) {
      if (account !== null) {
        await this.repository.recordAccessTokenFailure(account.accountId, "ACTIVATION");
      }
      throw genericAuthenticationError();
    }

    const passwordHash = await this.crypto.hashPassword(dto.password);
    const deviceId = randomUUID();
    const sessionToken = this.crypto.generateSessionToken();
    const employee = await this.repository.getEmployee(account.employeeId);
    const session = this.createSession(
      account.accountId,
      deviceId,
      account.authorizationVersion,
      employee,
      sessionToken,
    );

    await this.repository.activateAccount({
      accountId: account.accountId,
      correlationId,
      deviceId,
      deviceLabel: dto.deviceLabel.trim(),
      employeeId: account.employeeId,
      passwordHash,
      platformFamily: dto.platformFamily,
      publicKey: dto.publicKey,
      session,
      tokenHash,
    });

    return {
      body: await this.toAuthenticatedUser(account.employeeId, session, sessionToken),
      sessionToken,
    };
  }

  async login(dto: LoginDto, correlationId: string, source: string): Promise<SessionResult> {
    const loginNormalized = this.crypto.normalizeLogin(dto.login);
    const rateLimitBucket = this.crypto.hashRateLimitBucket(source, loginNormalized);
    if (await this.repository.isLoginBucketBlocked(rateLimitBucket)) {
      throw genericAuthenticationError();
    }
    const account = await this.repository.findAccountByLogin(loginNormalized);
    const passwordValid = await this.crypto.verifyPassword(
      account?.passwordHash ?? null,
      dto.password,
    );
    const device = await this.repository.findActiveDevice(dto.deviceId);
    const accessAllowed =
      account !== null &&
      account.accountStatus === "ACTIVE" &&
      account.employeeStatus === "ACTIVE" &&
      (account.lockedUntil === null || account.lockedUntil <= new Date()) &&
      passwordValid &&
      device !== null &&
      device.employeeId === account.employeeId;

    if (!accessAllowed || account === null || device === null) {
      await this.repository.recordLoginBucketFailure(rateLimitBucket);
      await this.repository.recordLoginFailure(account?.accountId ?? null, correlationId);
      throw genericAuthenticationError();
    }

    const sessionToken = this.crypto.generateSessionToken();
    const employee = await this.repository.getEmployee(account.employeeId);
    const session = this.createSession(
      account.accountId,
      device.id,
      account.authorizationVersion,
      employee,
      sessionToken,
    );
    await this.repository.createLoginSession({
      accountId: account.accountId,
      correlationId,
      deviceId: device.id,
      employeeId: account.employeeId,
      session,
    });
    await this.repository.clearLoginBucket(rateLimitBucket);

    return {
      body: this.authenticatedUser(employee, session, sessionToken),
      sessionToken,
    };
  }

  async currentUser(
    deviceId: string,
    employeeId: string,
    sessionExpiresAt: Date,
    sessionToken: string,
  ): Promise<AuthenticatedUser> {
    const employee = await this.repository.getEmployee(employeeId);
    return {
      csrfToken: this.crypto.createCsrfToken(sessionToken),
      deviceId,
      employee,
      sessionExpiresAt: sessionExpiresAt.toISOString(),
    };
  }

  private createSession(
    accountId: string,
    deviceId: string,
    authorizationVersion: number,
    employee: EmployeeSummary,
    sessionToken: string,
  ): NewSession {
    const now = Date.now();
    const privileged = employee.roles.some((role) => privilegedRoles.has(role.roleCode));
    return {
      absoluteExpiresAt: new Date(
        now + (privileged ? 12 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000),
      ),
      accessExpiresAt: new Date(now + (privileged ? 30 : 15) * 60 * 1000),
      accountId,
      authorizationVersion,
      deviceId,
      id: randomUUID(),
      refreshExpiresAt: privileged ? null : new Date(now + 7 * 24 * 60 * 60 * 1000),
      tokenHash: this.crypto.hashSessionToken(sessionToken),
    };
  }

  private async toAuthenticatedUser(
    employeeId: string,
    session: NewSession,
    sessionToken: string,
  ): Promise<AuthenticatedUser> {
    return this.authenticatedUser(
      await this.repository.getEmployee(employeeId),
      session,
      sessionToken,
    );
  }

  private authenticatedUser(
    employee: EmployeeSummary,
    session: NewSession,
    sessionToken: string,
  ): AuthenticatedUser {
    return {
      csrfToken: this.crypto.createCsrfToken(sessionToken),
      deviceId: session.deviceId,
      employee,
      sessionExpiresAt: session.accessExpiresAt.toISOString(),
    };
  }
}

function genericAuthenticationError(): UnauthorizedException {
  return new UnauthorizedException({
    code: "AUTHENTICATION_FAILED",
    message: "Не удалось выполнить вход. Проверьте данные или обратитесь к администратору",
  });
}
