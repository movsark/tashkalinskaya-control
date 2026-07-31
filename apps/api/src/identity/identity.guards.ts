import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { RoleCode } from "@tashkalinskaya/contracts";

import { IdentityCryptoService } from "./identity-crypto.service";
import { IdentityRepository } from "./identity.repository";
import type { AuthenticatedRequest } from "./identity.types";

export const SESSION_COOKIE_NAME = "tashkalinskaya_session";
const requiredRolesKey = "required-roles";

export const RequireRoles = (...roles: RoleCode[]) => SetMetadata(requiredRolesKey, roles);

@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(
    private readonly crypto: IdentityCryptoService,
    private readonly repository: IdentityRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
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
    const actor = request.actor;
    const token = request.header("x-csrf-token");
    if (
      actor === undefined ||
      token === undefined ||
      !this.crypto.verifyCsrfToken(actor.sessionToken, token)
    ) {
      if (actor !== undefined) {
        await this.repository.recordAccessDenied({
          actorEmployeeId: actor.employee.id,
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
        assignment.scopeType === "FACTORY" &&
        assignment.scopeId === null,
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
import { randomUUID } from "node:crypto";
