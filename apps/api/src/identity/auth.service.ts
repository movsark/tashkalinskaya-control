import { randomUUID } from "node:crypto";

import { ConflictException, Injectable, UnauthorizedException } from "@nestjs/common";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import type {
  AccountProfileView,
  AuthenticatedUser,
  EmployeeSummary,
  PhoneRecoveryResult,
  RoleCode,
  ScopeType,
} from "@tashkalinskaya/contracts";

import type {
  ActivateAccountDto,
  ActivationOptionsDto,
  AssertionDto,
  ChangePasswordDto,
  ConfirmPhoneRecoveryDto,
  ConfirmPhoneVerificationDto,
  LoginDto,
  LoginOptionsDto,
  PreviewEmployeeRegistrationDto,
  RecoverAccountDto,
  RegisterEmployeeDto,
  RequestPhoneRecoveryDto,
  RequestPhoneVerificationDto,
  RecoveryOptionsDto,
  StepUpDto,
} from "./identity.dto";
import { DeviceSecurityRepository } from "./device-security.repository";
import { IdentityCryptoService } from "./identity-crypto.service";
import { IdentityRepository, type NewSession } from "./identity.repository";
import type { AuthenticatedActor } from "./identity.types";
import { maskPhone, normalizePhone } from "./phone-number";
import { SmsRuService } from "./sms-ru.service";
import { WebAuthnService } from "./webauthn.service";

const persistentSessionMilliseconds = 365 * 24 * 60 * 60 * 1000;
const localUatWorkshopId = "21000000-0000-4000-8000-000000000001";
const localUatWarehouseId = "23000000-0000-4000-8000-000000000001";
const localUatStoreId = "24000000-0000-4000-8000-000000000001";

export interface LocalUatProfile {
  readonly displayName: string;
  readonly label: string;
  readonly roleCode: RoleCode;
  readonly scopeId: string | null;
  readonly scopeType: ScopeType;
}

const localUatProfiles: readonly LocalUatProfile[] = [
  {
    displayName: "Тестовый Администратор",
    label: "Администратор",
    roleCode: "ADMIN",
    scopeId: null,
    scopeType: "FACTORY",
  },
  {
    displayName: "Тестовый Руководитель",
    label: "Руководитель",
    roleCode: "MANAGER",
    scopeId: null,
    scopeType: "FACTORY",
  },
  {
    displayName: "Тестовый Бухгалтер",
    label: "Бухгалтер",
    roleCode: "ACCOUNTANT",
    scopeId: null,
    scopeType: "FACTORY",
  },
  {
    displayName: "Тестовый Ответственный",
    label: "Ответственный цеха",
    roleCode: "WORKSHOP_MANAGER",
    scopeId: localUatWorkshopId,
    scopeType: "WORKSHOP",
  },
  {
    displayName: "Тестовый Кондитер",
    label: "Кондитер",
    roleCode: "CONFECTIONER",
    scopeId: localUatWorkshopId,
    scopeType: "WORKSHOP",
  },
  {
    displayName: "Тестовый Кладовщик",
    label: "Кладовщик",
    roleCode: "WAREHOUSE_KEEPER",
    scopeId: localUatWarehouseId,
    scopeType: "WAREHOUSE",
  },
  {
    displayName: "Тестовый Водитель",
    label: "Водитель",
    roleCode: "DRIVER",
    scopeId: null,
    scopeType: "FACTORY",
  },
  {
    displayName: "Тестовый Продавец",
    label: "Продавец магазина",
    roleCode: "STORE_SELLER",
    scopeId: localUatStoreId,
    scopeType: "STORE",
  },
  {
    displayName: "Тестовый Сотрудник",
    label: "Только табель",
    roleCode: "ATTENDANCE_ONLY",
    scopeId: null,
    scopeType: "FACTORY",
  },
];

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
    private readonly sms: SmsRuService,
    private readonly webauthn: WebAuthnService,
  ) {}

  async accountProfile(actor: AuthenticatedActor): Promise<AccountProfileView> {
    const profile = await this.repository.getAccountProfile(actor.accountId);
    return {
      fullName: profile.fullName,
      login: profile.login,
      phoneMasked: maskPhone(profile.phoneE164),
      phoneVerified: profile.phoneVerified,
      smsRecoveryAvailable: this.sms.available,
    };
  }

  recoveryConfig(): { smsRecoveryAvailable: boolean } {
    return { smsRecoveryAvailable: this.sms.available };
  }

  localUatProfiles(): readonly Pick<LocalUatProfile, "label" | "roleCode">[] {
    return localUatProfiles.map(({ label, roleCode }) => ({ label, roleCode }));
  }

  async localUatLogin(roleCode: RoleCode, correlationId: string): Promise<SessionResult> {
    const profile = localUatProfiles.find((candidate) => candidate.roleCode === roleCode);
    if (profile === undefined) throw genericAuthenticationError();
    const login = `local-uat-${roleCode.toLocaleLowerCase("en-US")}`;
    const account = await this.repository.ensureLocalUatProfile({
      departmentId: profile.scopeType === "WORKSHOP" ? localUatWorkshopId : null,
      displayName: profile.displayName,
      login,
      passwordHash: await this.crypto.hashPassword(`Local UAT ${randomUUID()}`),
      roleCode: profile.roleCode,
      scopeId: profile.scopeId,
      scopeType: profile.scopeType,
    });
    const sessionToken = this.crypto.generateSessionToken();
    const session = this.createSession(
      account.accountId,
      account.deviceId,
      account.authorizationVersion,
      sessionToken,
    );
    await this.repository.createLoginSession({
      accountId: account.accountId,
      correlationId,
      deviceId: account.deviceId,
      employeeId: account.employeeId,
      session,
    });
    return {
      body: await this.toAuthenticatedUser(account.employeeId, session, sessionToken),
      cookieExpiresAt: session.accessExpiresAt.toISOString(),
      sessionToken,
    };
  }

  async changePassword(
    dto: ChangePasswordDto,
    actor: AuthenticatedActor,
    correlationId: string,
  ): Promise<void> {
    const account = await this.repository.findAccountByLogin(actor.employee.login);
    const valid = await this.crypto.verifyPassword(
      account?.passwordHash ?? null,
      dto.currentPassword,
    );
    if (account === null || account.accountId !== actor.accountId || !valid) {
      throw genericAuthenticationError();
    }
    await this.repository.changePassword({
      accountId: actor.accountId,
      correlationId,
      employeeId: actor.employee.id,
      passwordHash: await this.crypto.hashPassword(dto.newPassword),
      sessionId: actor.sessionId,
    });
  }

  async requestPhoneVerification(
    dto: RequestPhoneVerificationDto,
    actor: AuthenticatedActor,
    correlationId: string,
    source: string,
  ): Promise<{ message: string }> {
    const account = await this.repository.findAccountByLogin(actor.employee.login);
    const passwordValid = await this.crypto.verifyPassword(
      account?.passwordHash ?? null,
      dto.currentPassword,
    );
    if (account === null || account.accountId !== actor.accountId || !passwordValid) {
      throw genericAuthenticationError();
    }
    const phoneE164 = normalizePhone(dto.phone);
    const code = this.crypto.generatePhoneCode();
    const tokenHash = this.crypto.hashAccessCode(code);
    const issued = await this.repository.issuePhoneCode({
      accountId: actor.accountId,
      actorEmployeeId: actor.employee.id,
      correlationId,
      phoneE164,
      purpose: "PHONE_VERIFICATION",
      requestBucketHash: this.crypto.hashRateLimitBucket(source, `phone:${phoneE164}`),
      tokenHash,
    });
    if (!issued) {
      throw new ConflictException({
        code: "PHONE_CODE_COOLDOWN",
        message: "Новый код можно запросить через минуту",
      });
    }
    try {
      await this.sms.sendCode(phoneE164, code, "PHONE_VERIFICATION");
      await this.repository.markPhoneCodeDelivered(tokenHash);
    } catch (error) {
      await this.repository.invalidatePhoneCode(tokenHash);
      throw error;
    }
    return { message: "Код подтверждения отправлен" };
  }

  async confirmPhoneVerification(
    dto: ConfirmPhoneVerificationDto,
    actor: AuthenticatedActor,
    correlationId: string,
  ): Promise<void> {
    try {
      await this.repository.confirmPhone({
        accountId: actor.accountId,
        actorEmployeeId: actor.employee.id,
        correlationId,
        tokenHash: this.crypto.hashAccessCode(dto.code),
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException({
          code: "PHONE_ALREADY_USED",
          message: "Этот номер уже привязан к другой учётной записи",
        });
      }
      throw error;
    }
  }

  async requestPhoneRecovery(
    dto: RequestPhoneRecoveryDto,
    correlationId: string,
    source: string,
  ): Promise<{ message: string }> {
    const startedAt = Date.now();
    const phoneE164 = normalizePhone(dto.phone);
    const requestBucket = this.crypto.hashRateLimitBucket(source, `recovery:${phoneE164}`);
    const blocked = await this.repository.isLoginBucketBlocked(requestBucket);
    if (!blocked) {
      await this.repository.recordLoginBucketFailure(requestBucket);
      const account = await this.repository.findAccountByVerifiedPhone(phoneE164);
      if (
        this.sms.available &&
        account !== null &&
        account.accountStatus === "ACTIVE" &&
        account.employeeStatus === "ACTIVE"
      ) {
        const code = this.crypto.generatePhoneCode();
        const tokenHash = this.crypto.hashAccessCode(code);
        const issued = await this.repository.issuePhoneCode({
          accountId: account.accountId,
          actorEmployeeId: null,
          correlationId,
          phoneE164,
          purpose: "PASSWORD_RECOVERY",
          requestBucketHash: requestBucket,
          tokenHash,
        });
        if (issued) {
          try {
            await this.sms.sendCode(phoneE164, code, "PASSWORD_RECOVERY");
            await this.repository.markPhoneCodeDelivered(tokenHash);
          } catch {
            await this.repository.invalidatePhoneCode(tokenHash);
          }
        }
      }
    }
    await waitForMinimumDuration(startedAt, 600);
    return {
      message: "Если этот номер подтверждён в системе, код восстановления будет отправлен по SMS",
    };
  }

  async confirmPhoneRecovery(
    dto: ConfirmPhoneRecoveryDto,
    correlationId: string,
    source: string,
  ): Promise<PhoneRecoveryResult> {
    const phoneE164 = normalizePhone(dto.phone);
    const attemptBucket = this.crypto.hashRateLimitBucket(source, `confirm:${phoneE164}`);
    if (await this.repository.isLoginBucketBlocked(attemptBucket)) {
      throw genericAuthenticationError();
    }
    try {
      const result = await this.repository.completePhoneRecovery({
        correlationId,
        deviceId: dto.deviceId,
        deviceLabel: dto.deviceLabel.trim(),
        passwordHash: await this.crypto.hashPassword(dto.newPassword),
        phoneE164,
        platformFamily: dto.platformFamily,
        tokenHash: this.crypto.hashAccessCode(dto.code),
      });
      await this.repository.clearLoginBucket(attemptBucket);
      return { deviceId: dto.deviceId, login: result.login };
    } catch (error) {
      await this.repository.recordLoginBucketFailure(attemptBucket);
      throw error;
    }
  }

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
    const session = this.createSession(
      account.accountId,
      deviceId,
      account.authorizationVersion,
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

  async registrationPreview(dto: PreviewEmployeeRegistrationDto) {
    const invitation = await this.repository.findEmployeeInvitation(
      this.crypto.hashAccessCode(dto.invitationCode),
    );
    if (invitation === null) throw invalidInvitationError();
    return {
      expiresAt: invitation.expiresAt.toISOString(),
      roleCode: invitation.roleCode,
      roleDisplayName: invitation.roleDisplayName,
      scopeDisplayName: invitation.scopeDisplayName,
    };
  }

  async registerEmployee(dto: RegisterEmployeeDto, correlationId: string): Promise<SessionResult> {
    const invitation = await this.repository.findEmployeeInvitation(
      this.crypto.hashAccessCode(dto.invitationCode),
    );
    if (invitation === null) throw invalidInvitationError();
    const employeeId = randomUUID();
    const accountId = randomUUID();
    const sessionToken = this.crypto.generateSessionToken();
    const session = this.createSession(accountId, dto.deviceId, 1, sessionToken);
    const fullName = [dto.lastName, dto.firstName, dto.patronymic]
      .filter((part): part is string => part !== undefined && part.trim() !== "")
      .map((part) => part.trim())
      .join(" ");
    try {
      await this.repository.registerEmployeeFromInvitation({
        accountId,
        correlationId,
        deviceId: dto.deviceId,
        employeeId,
        fullName,
        invitationId: invitation.id,
        loginNormalized: this.crypto.normalizeLogin(dto.login),
        passwordHash: await this.crypto.hashPassword(dto.password),
        platformFamily: dto.platformFamily,
        session,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException({
          code: "REGISTRATION_DATA_ALREADY_USED",
          message: "Такой логин уже занят. Выберите другой логин",
        });
      }
      throw error;
    }
    return {
      body: await this.toAuthenticatedUser(employeeId, session, sessionToken),
      cookieExpiresAt: session.accessExpiresAt.toISOString(),
      sessionToken,
    };
  }

  async loginOptions(dto: LoginOptionsDto) {
    const loginNormalized = this.crypto.normalizeLogin(dto.login);
    const account = await this.repository.findAccountByLogin(loginNormalized);
    const device =
      account === null
        ? null
        : await this.repository.findActiveDeviceByEmployee(account.employeeId);
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
    const deviceId = randomUUID();
    const session = this.createSession(
      account.accountId,
      deviceId,
      account.authorizationVersion,
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
    sessionId: string,
    sessionToken: string,
  ): Promise<AuthenticatedUser> {
    const employee = await this.repository.getEmployee(employeeId);
    const sessionExpiresAt = await this.repository.extendSession(sessionId);
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
    sessionToken: string,
  ): NewSession {
    const now = Date.now();
    const expiresAt = new Date(now + persistentSessionMilliseconds);
    return {
      absoluteExpiresAt: expiresAt,
      accessExpiresAt: expiresAt,
      accountId,
      authorizationVersion,
      deviceId,
      id: randomUUID(),
      refreshExpiresAt: null,
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

function invalidInvitationError(): UnauthorizedException {
  return new UnauthorizedException({
    code: "EMPLOYEE_INVITATION_INVALID",
    message: "Приглашение недействительно, уже использовано или закончилось",
  });
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}

async function waitForMinimumDuration(startedAt: number, milliseconds: number): Promise<void> {
  const remaining = milliseconds - (Date.now() - startedAt);
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
}
