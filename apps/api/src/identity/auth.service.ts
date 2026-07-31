import { randomUUID } from "node:crypto";

import { Injectable, UnauthorizedException } from "@nestjs/common";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import type { AuthenticatedUser, EmployeeSummary } from "@tashkalinskaya/contracts";

import type {
  ActivateAccountDto,
  ActivationOptionsDto,
  AssertionDto,
  LoginDto,
  LoginOptionsDto,
  RecoverAccountDto,
  RecoveryOptionsDto,
  StepUpDto,
} from "./identity.dto";
import { DeviceSecurityRepository } from "./device-security.repository";
import { IdentityCryptoService } from "./identity-crypto.service";
import { IdentityRepository, type NewSession } from "./identity.repository";
import type { AuthenticatedActor } from "./identity.types";
import { WebAuthnService } from "./webauthn.service";

const privilegedRoles = new Set(["ADMIN", "MANAGER", "ACCOUNTANT"]);

interface SessionResult {
  readonly body: AuthenticatedUser;
  readonly cookieExpiresAt: string;
  readonly sessionToken: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly crypto: IdentityCryptoService,
    private readonly deviceSecurity: DeviceSecurityRepository,
    private readonly repository: IdentityRepository,
    private readonly webauthn: WebAuthnService,
  ) {}

  async activationOptions(dto: ActivationOptionsDto) {
    const loginNormalized = this.crypto.normalizeLogin(dto.login);
    const account = await this.repository.findAccountByLogin(loginNormalized);
    const tokenHash = this.crypto.hashAccessCode(dto.activationCode);
    const valid =
      account !== null &&
      account.accountStatus === "INVITED" &&
      account.employeeStatus === "ACTIVE" &&
      (await this.repository.findValidAccessToken(account.accountId, "ACTIVATION", tokenHash));
    if (!valid || account === null) {
      if (account !== null) {
        await this.repository.recordAccessTokenFailure(account.accountId, "ACTIVATION");
      }
      throw genericAuthenticationError();
    }
    const employee = await this.repository.getEmployee(account.employeeId);
    return this.webauthn.registrationOptions({
      accountId: account.accountId,
      displayName: employee.fullName,
      purpose: "ACTIVATION",
      userId: account.employeeId,
      userName: loginNormalized,
    });
  }

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

    const credential = await this.webauthn.verifyRegistration({
      accountId: account.accountId,
      challengeId: dto.challengeId,
      purpose: "ACTIVATION",
      response: dto.credential as unknown as RegistrationResponseJSON,
    });
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
      credential,
      session,
      tokenHash,
    });

    return {
      body: await this.toAuthenticatedUser(account.employeeId, session, sessionToken),
      cookieExpiresAt: (session.refreshExpiresAt ?? session.accessExpiresAt).toISOString(),
      sessionToken,
    };
  }

  async loginOptions(dto: LoginOptionsDto) {
    const loginNormalized = this.crypto.normalizeLogin(dto.login);
    const account = await this.repository.findAccountByLogin(loginNormalized);
    const device = await this.repository.findActiveDevice(dto.deviceId);
    if (
      account === null ||
      account.accountStatus !== "ACTIVE" ||
      account.employeeStatus !== "ACTIVE" ||
      device === null ||
      device.employeeId !== account.employeeId
    ) {
      throw genericAuthenticationError();
    }
    return this.webauthn.authenticationOptions({
      accountId: account.accountId,
      device,
      purpose: "LOGIN",
    });
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
      device.employeeId === account.employeeId &&
      device.webauthnCredentialId !== null;

    if (!accessAllowed || account === null || device === null) {
      await this.repository.recordLoginBucketFailure(rateLimitBucket);
      await this.repository.recordLoginFailure(account?.accountId ?? null, correlationId);
      throw genericAuthenticationError();
    }

    const newCounter = await this.webauthn
      .verifyAuthentication({
        accountId: account.accountId,
        challengeId: dto.challengeId,
        device,
        purpose: "LOGIN",
        response: dto.credential as unknown as AuthenticationResponseJSON,
      })
      .catch(async (error) => {
        await this.repository.recordLoginBucketFailure(rateLimitBucket);
        await this.repository.recordLoginFailure(account.accountId, correlationId);
        throw error;
      });
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
    await this.repository.updateDeviceCounter(device.id, newCounter);
    await this.repository.clearLoginBucket(rateLimitBucket);

    return {
      body: this.authenticatedUser(employee, session, sessionToken),
      cookieExpiresAt: (session.refreshExpiresAt ?? session.accessExpiresAt).toISOString(),
      sessionToken,
    };
  }

  async refreshOptions(sessionToken: string) {
    const session = await this.repository.findRefreshSessionByHash(
      this.crypto.hashSessionToken(sessionToken),
    );
    if (session === null) throw genericAuthenticationError();
    const device = await this.repository.findActiveDevice(session.personalDeviceId);
    if (device === null || device.employeeId !== session.employeeId) {
      throw genericAuthenticationError();
    }
    return this.webauthn.authenticationOptions({
      accountId: session.accountId,
      device,
      purpose: "REFRESH",
    });
  }

  async refresh(
    dto: AssertionDto,
    previousSessionToken: string,
    correlationId: string,
  ): Promise<SessionResult> {
    const previous = await this.repository.findRefreshSessionByHash(
      this.crypto.hashSessionToken(previousSessionToken),
    );
    if (previous === null) throw genericAuthenticationError();
    const device = await this.repository.findActiveDevice(previous.personalDeviceId);
    if (device === null || device.employeeId !== previous.employeeId) {
      throw genericAuthenticationError();
    }
    const newCounter = await this.webauthn.verifyAuthentication({
      accountId: previous.accountId,
      challengeId: dto.challengeId,
      device,
      purpose: "REFRESH",
      response: dto.credential as unknown as AuthenticationResponseJSON,
    });
    const now = Date.now();
    const sessionToken = this.crypto.generateSessionToken();
    const refreshExpiresAt = new Date(
      Math.min(now + 7 * 24 * 60 * 60 * 1000, previous.absoluteExpiresAt.getTime()),
    );
    const session: NewSession = {
      absoluteExpiresAt: previous.absoluteExpiresAt,
      accessExpiresAt: new Date(
        Math.min(now + 15 * 60 * 1000, previous.absoluteExpiresAt.getTime()),
      ),
      accountId: previous.accountId,
      authorizationVersion: previous.authorizationVersion,
      deviceId: previous.personalDeviceId,
      id: randomUUID(),
      refreshExpiresAt,
      tokenHash: this.crypto.hashSessionToken(sessionToken),
    };
    await this.repository.rotateSession({
      correlationId,
      employeeId: previous.employeeId,
      previousSessionId: previous.sessionId,
      session,
    });
    await this.repository.updateDeviceCounter(device.id, newCounter);
    return {
      body: await this.toAuthenticatedUser(previous.employeeId, session, sessionToken),
      cookieExpiresAt: refreshExpiresAt.toISOString(),
      sessionToken,
    };
  }

  async stepUpOptions(actor: AuthenticatedActor) {
    const device = await this.repository.findActiveDevice(actor.deviceId);
    if (device === null || device.employeeId !== actor.employee.id) {
      throw genericAuthenticationError();
    }
    return this.webauthn.authenticationOptions({
      accountId: actor.accountId,
      device,
      purpose: "STEP_UP",
    });
  }

  async stepUp(
    dto: StepUpDto,
    actor: AuthenticatedActor,
    correlationId: string,
  ): Promise<{ expiresAt: string }> {
    const account = await this.repository.findAccountByLogin(actor.employee.login);
    const device = await this.repository.findActiveDevice(actor.deviceId);
    const passwordValid = await this.crypto.verifyPassword(
      account?.passwordHash ?? null,
      dto.password,
    );
    if (
      account === null ||
      account.accountId !== actor.accountId ||
      device === null ||
      device.employeeId !== actor.employee.id ||
      !passwordValid
    ) {
      throw genericAuthenticationError();
    }
    const newCounter = await this.webauthn.verifyAuthentication({
      accountId: account.accountId,
      challengeId: dto.challengeId,
      device,
      purpose: "STEP_UP",
      response: dto.credential as unknown as AuthenticationResponseJSON,
    });
    await this.repository.updateDeviceCounter(device.id, newCounter);
    const expiresAt = await this.repository.markSessionStepUp(
      actor.sessionId,
      actor.employee.id,
      correlationId,
    );
    return { expiresAt: expiresAt.toISOString() };
  }

  async recoveryOptions(dto: RecoveryOptionsDto) {
    const loginNormalized = this.crypto.normalizeLogin(dto.login);
    const account = await this.repository.findAccountByLogin(loginNormalized);
    const tokenHash = this.crypto.hashAccessCode(dto.recoveryCode);
    const valid =
      account !== null &&
      account.employeeStatus === "ACTIVE" &&
      (await this.repository.findValidAccessToken(account.accountId, "RECOVERY", tokenHash));
    if (!valid || account === null) {
      if (account !== null)
        await this.repository.recordAccessTokenFailure(account.accountId, "RECOVERY");
      throw genericAuthenticationError();
    }
    const employee = await this.repository.getEmployee(account.employeeId);
    return this.webauthn.registrationOptions({
      accountId: account.accountId,
      displayName: employee.fullName,
      purpose: "RECOVERY",
      userId: account.employeeId,
      userName: loginNormalized,
    });
  }

  async recover(dto: RecoverAccountDto, correlationId: string): Promise<SessionResult> {
    const loginNormalized = this.crypto.normalizeLogin(dto.login);
    const account = await this.repository.findAccountByLogin(loginNormalized);
    const tokenHash = this.crypto.hashAccessCode(dto.recoveryCode);
    const valid =
      account !== null &&
      account.employeeStatus === "ACTIVE" &&
      (await this.repository.findValidAccessToken(account.accountId, "RECOVERY", tokenHash));
    if (!valid || account === null) throw genericAuthenticationError();
    const credential = await this.webauthn.verifyRegistration({
      accountId: account.accountId,
      challengeId: dto.challengeId,
      purpose: "RECOVERY",
      response: dto.credential as unknown as RegistrationResponseJSON,
    });
    const passwordHash = await this.crypto.hashPassword(dto.password);
    const sessionToken = this.crypto.generateSessionToken();
    const employee = await this.repository.getEmployee(account.employeeId);
    const deviceId = randomUUID();
    const session = this.createSession(
      account.accountId,
      deviceId,
      account.authorizationVersion,
      employee,
      sessionToken,
    );
    await this.deviceSecurity.recoverAccount({
      accountId: account.accountId,
      correlationId,
      credential,
      deviceId,
      deviceLabel: dto.deviceLabel.trim(),
      employeeId: account.employeeId,
      passwordHash,
      platformFamily: dto.platformFamily,
      session,
      tokenHash,
    });
    return {
      body: await this.toAuthenticatedUser(account.employeeId, session, sessionToken),
      cookieExpiresAt: (session.refreshExpiresAt ?? session.accessExpiresAt).toISOString(),
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
