import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { RoleCode } from "@tashkalinskaya/contracts";

import { API_CONFIG, type ApiConfig } from "../config";
import { IdentityCryptoService } from "./identity-crypto.service";
import { DeviceSecurityRepository } from "./device-security.repository";
import { IdentityRepository } from "./identity.repository";
import type { AuthenticatedActor, AuthenticatedRequest } from "./identity.types";

export const SESSION_COOKIE_NAME = "tashkalinskaya_session";
export const TERMINAL_SESSION_COOKIE_NAME = "tashkalinskaya_terminal_session";
export const STAGING_LOAD_TOKEN_HEADER = "x-staging-load-token";
const requiredRolesKey = "required-roles";
const factoryOnlyRoles: readonly RoleCode[] = ["ADMIN", "MANAGER", "ACCOUNTANT"];
const readOnlyMethods = new Set(["GET", "HEAD", "OPTIONS"]);
const stagingLoadActorCacheTtlMs = 5_000;

export const RequireRoles = (...roles: RoleCode[]) => SetMetadata(requiredRolesKey, roles);

@Injectable()
export class SessionAuthGuard implements CanActivate {
  private stagingLoadActorCache: { actor: AuthenticatedActor; expiresAt: number } | null = null;
  private stagingLoadActorLookup: Promise<AuthenticatedActor | null> | null = null;

  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly crypto: IdentityCryptoService,
    private readonly repository: IdentityRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const stagingLoadToken = request.header(STAGING_LOAD_TOKEN_HEADER);
    if (stagingLoadToken !== undefined) {
      const access = this.config.stagingLoadAccess;
      if (access === null || !matchesSha256(stagingLoadToken, access.tokenSha256)) {
        throw authenticationRequired();
      }
      if (!readOnlyMethods.has(request.method.toUpperCase())) {
        throw new ForbiddenException({
          code: "STAGING_LOAD_READ_ONLY",
          message: "Нагрузочный доступ разрешает только чтение данных staging",
        });
      }
      const actor = await this.resolveStagingLoadActor(access.login);
      if (actor === null) throw authenticationRequired();
      request.actor = actor;
      return true;
    }
    const cookieHeader = request.headers.cookie;
    const sessionToken = readCookie(cookieHeader, SESSION_COOKIE_NAME);
    if (sessionToken === undefined || sessionToken.length < 40) throw authenticationRequired();

    const actor = await this.repository.findActorBySessionHash(
      this.crypto.hashSessionToken(sessionToken),
      sessionToken,
    );
    if (actor === null) throw authenticationRequired();
    request.actor = actor;
    void this.repository.touchSession(actor.sessionId);
    return true;
  }

  private async resolveStagingLoadActor(login: string): Promise<AuthenticatedActor | null> {
    const now = Date.now();
    if (this.stagingLoadActorCache !== null && this.stagingLoadActorCache.expiresAt > now) {
      return this.stagingLoadActorCache.actor;
    }
    if (this.stagingLoadActorLookup !== null) return this.stagingLoadActorLookup;

    this.stagingLoadActorLookup = this.repository
      .findStagingLoadActor(login)
      .then((actor) => {
        if (actor !== null) {
          this.stagingLoadActorCache = {
            actor,
            expiresAt: Date.now() + stagingLoadActorCacheTtlMs,
          };
        }
        return actor;
      })
      .finally(() => {
        this.stagingLoadActorLookup = null;
      });
    return this.stagingLoadActorLookup;
  }
}

export function matchesSha256(value: string, expectedHexDigest: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(expectedHexDigest)) return false;
  const actual = createHash("sha256").update(value, "utf8").digest();
  const expected = Buffer.from(expectedHexDigest, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

@Injectable()
export class TerminalSessionAuthGuard implements CanActivate {
  constructor(
    private readonly crypto: IdentityCryptoService,
    private readonly repository: DeviceSecurityRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const sessionToken = readCookie(request.headers.cookie, TERMINAL_SESSION_COOKIE_NAME);
    if (sessionToken === undefined || sessionToken.length < 40) throw authenticationRequired();
    const terminal = await this.repository.findTerminalBySessionHash(
      this.crypto.hashSessionToken(sessionToken),
      sessionToken,
    );
    if (terminal === null) throw authenticationRequired();
    request.terminal = terminal;
    return true;
  }
}

@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(
    private readonly crypto: IdentityCryptoService,
    private readonly repository: IdentityRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return true;
    const principal = request.actor ?? request.terminal;
    const token = request.header("x-csrf-token");
    if (
      principal === undefined ||
      token === undefined ||
      !this.crypto.verifyCsrfToken(principal.sessionToken, token)
    ) {
      if (request.actor !== undefined) {
        await this.repository.recordAccessDenied({
          actorEmployeeId: request.actor.employee.id,
          correlationId: request.correlationId ?? randomUUID(),
          method: request.method,
          path: request.path,
          reason: "CSRF_REJECTED",
        });
      }
      throw new ForbiddenException({
        code: "CSRF_REJECTED",
        message: "Защитный токен запроса недействителен",
      });
    }
    return true;
  }
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly repository: IdentityRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredRoles =
      this.reflector.getAllAndOverride<RoleCode[]>(requiredRolesKey, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];
    if (requiredRoles.length === 0) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authorized = request.actor?.roles.some(
      (assignment) =>
        requiredRoles.includes(assignment.roleCode) &&
        (!factoryOnlyRoles.includes(assignment.roleCode) ||
          (assignment.scopeType === "FACTORY" && assignment.scopeId === null)),
    );
    if (!authorized) {
      const actor = request.actor;
      if (actor !== undefined) {
        await this.repository.recordAccessDenied({
          actorEmployeeId: actor.employee.id,
          correlationId: request.correlationId ?? randomUUID(),
          method: request.method,
          path: request.path,
          reason: "ROLE_REJECTED",
        });
      }
      throw new ForbiddenException({
        code: "ACCESS_DENIED",
        message: "Недостаточно прав для этой операции",
      });
    }
    return true;
  }
}

@Injectable()
export class StepUpGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const expiresAt = request.actor?.stepUpExpiresAt;
    if (expiresAt === null || expiresAt === undefined || expiresAt <= new Date()) {
      throw new ForbiddenException({
        code: "STEP_UP_REQUIRED",
        message: "Повторно подтвердите пароль и системный PIN или биометрию",
      });
    }
    return true;
  }
}

function authenticationRequired(): UnauthorizedException {
  return new UnauthorizedException({
    code: "AUTHENTICATION_REQUIRED",
    message: "Требуется вход в систему",
  });
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}
