import { createHash } from "node:crypto";

import type { ExecutionContext } from "@nestjs/common";
import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import { describe, expect, it, vi } from "vitest";

import type { ApiConfig } from "../config";
import type { IdentityCryptoService } from "./identity-crypto.service";
import {
  RolesGuard,
  SessionAuthGuard,
  STAGING_LOAD_TOKEN_HEADER,
  StepUpGuard,
} from "./identity.guards";
import type { IdentityRepository } from "./identity.repository";
import type { AuthenticatedRequest } from "./identity.types";

function contextFor(request: Partial<AuthenticatedRequest>): ExecutionContext {
  return {
    getClass: () => class TestController {},
    getHandler: () => function handler() {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function actorWithRole(
  scopeType: "FACTORY" | "STORE" | "WORKSHOP",
  stepUpExpiresAt: Date | null,
  roleCode: "ADMIN" | "STORE_SELLER" = "ADMIN",
) {
  return {
    accountId: "account-1",
    deviceId: "device-1",
    employee: {
      accountStatus: "ACTIVE" as const,
      departmentId: null,
      employmentStatus: "ACTIVE" as const,
      fullName: "Тестовый администратор",
      id: "employee-1",
      login: "admin",
      personnelNumber: "1",
      roles: [],
      version: 1,
    },
    roles: [
      {
        id: "role-1",
        roleCode,
        scopeId: scopeType === "FACTORY" ? null : "11111111-1111-4111-8111-111111111111",
        scopeType,
      },
    ],
    sessionExpiresAt: new Date(Date.now() + 60_000),
    sessionId: "session-1",
    sessionToken: "token",
    stepUpExpiresAt,
  };
}

describe("administrative guards", () => {
  it("accepts the required factory role", async () => {
    const reflector = { getAllAndOverride: vi.fn().mockReturnValue(["ADMIN"]) };
    const repository = { recordAccessDenied: vi.fn() };
    const guard = new RolesGuard(
      reflector as unknown as Reflector,
      repository as unknown as IdentityRepository,
    );

    await expect(
      guard.canActivate(contextFor({ actor: actorWithRole("FACTORY", null) })),
    ).resolves.toBe(true);
  });

  it("rejects the same role when it is limited to a workshop", async () => {
    const reflector = { getAllAndOverride: vi.fn().mockReturnValue(["ADMIN"]) };
    const repository = { recordAccessDenied: vi.fn().mockResolvedValue(undefined) };
    const guard = new RolesGuard(
      reflector as unknown as Reflector,
      repository as unknown as IdentityRepository,
    );

    await expect(
      guard.canActivate(contextFor({ actor: actorWithRole("WORKSHOP", null) })),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repository.recordAccessDenied).toHaveBeenCalledOnce();
  });

  it("accepts an operational role in its domain scope", async () => {
    const reflector = { getAllAndOverride: vi.fn().mockReturnValue(["STORE_SELLER"]) };
    const repository = { recordAccessDenied: vi.fn() };
    const guard = new RolesGuard(
      reflector as unknown as Reflector,
      repository as unknown as IdentityRepository,
    );

    await expect(
      guard.canActivate(contextFor({ actor: actorWithRole("STORE", null, "STORE_SELLER") })),
    ).resolves.toBe(true);
  });

  it("requires a recent step-up for sensitive operations", async () => {
    const guard = new StepUpGuard();

    await expect(
      guard.canActivate(contextFor({ actor: actorWithRole("FACTORY", new Date(Date.now() - 1)) })),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      guard.canActivate(
        contextFor({ actor: actorWithRole("FACTORY", new Date(Date.now() + 60_000)) }),
      ),
    ).resolves.toBe(true);
  });
});

describe("staging load authentication", () => {
  const rawToken = "a-secure-random-staging-load-token-with-more-than-32-characters";
  const digest = createHash("sha256").update(rawToken).digest("hex");

  it("accepts a valid read-only staging token", async () => {
    const actor = actorWithRole("FACTORY", null);
    const repository = {
      findStagingLoadActor: vi.fn().mockResolvedValue(actor),
    };
    const guard = new SessionAuthGuard(
      configWithStagingLoad(digest),
      {} as IdentityCryptoService,
      repository as unknown as IdentityRepository,
    );
    const request = requestWithHeader("GET", rawToken);

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(request.actor).toBe(actor);
    expect(repository.findStagingLoadActor).toHaveBeenCalledWith("b20-admin");
  });

  it("coalesces concurrent staging actor lookups and caches the actor briefly", async () => {
    const actor = actorWithRole("FACTORY", null);
    const repository = {
      findStagingLoadActor: vi.fn().mockResolvedValue(actor),
    };
    const guard = new SessionAuthGuard(
      configWithStagingLoad(digest),
      {} as IdentityCryptoService,
      repository as unknown as IdentityRepository,
    );

    await Promise.all(
      Array.from({ length: 70 }, () =>
        guard.canActivate(contextFor(requestWithHeader("GET", rawToken))),
      ),
    );
    await guard.canActivate(contextFor(requestWithHeader("GET", rawToken)));

    expect(repository.findStagingLoadActor).toHaveBeenCalledOnce();
  });

  it("rejects a mutating request before resolving an actor", async () => {
    const repository = { findStagingLoadActor: vi.fn() };
    const guard = new SessionAuthGuard(
      configWithStagingLoad(digest),
      {} as IdentityCryptoService,
      repository as unknown as IdentityRepository,
    );

    await expect(
      guard.canActivate(contextFor(requestWithHeader("POST", rawToken))),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repository.findStagingLoadActor).not.toHaveBeenCalled();
  });

  it("rejects an invalid or disabled staging token", async () => {
    const repository = { findStagingLoadActor: vi.fn() };
    const invalidGuard = new SessionAuthGuard(
      configWithStagingLoad(digest),
      {} as IdentityCryptoService,
      repository as unknown as IdentityRepository,
    );
    const disabledGuard = new SessionAuthGuard(
      { stagingLoadAccess: null } as ApiConfig,
      {} as IdentityCryptoService,
      repository as unknown as IdentityRepository,
    );

    await expect(
      invalidGuard.canActivate(contextFor(requestWithHeader("GET", "wrong-token"))),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      disabledGuard.canActivate(contextFor(requestWithHeader("GET", rawToken))),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("keeps normal cookie sessions unchanged", async () => {
    const actor = actorWithRole("FACTORY", null);
    const crypto = { hashSessionToken: vi.fn().mockReturnValue("session-hash") };
    const repository = {
      findActorBySessionHash: vi.fn().mockResolvedValue(actor),
      touchSession: vi.fn().mockResolvedValue(undefined),
    };
    const guard = new SessionAuthGuard(
      { stagingLoadAccess: null } as ApiConfig,
      crypto as unknown as IdentityCryptoService,
      repository as unknown as IdentityRepository,
    );
    const sessionToken = "s".repeat(40);
    const request = {
      header: () => undefined,
      headers: { cookie: `tashkalinskaya_session=${sessionToken}` },
      method: "GET",
    } as Partial<AuthenticatedRequest> as AuthenticatedRequest;

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(repository.findActorBySessionHash).toHaveBeenCalledWith("session-hash", sessionToken);
  });
});

function configWithStagingLoad(tokenSha256: string): ApiConfig {
  return {
    stagingLoadAccess: { login: "b20-admin", tokenSha256 },
  } as ApiConfig;
}

function requestWithHeader(method: string, value: string): AuthenticatedRequest {
  return {
    header: (name: string) =>
      name.toLowerCase() === STAGING_LOAD_TOKEN_HEADER ? value : undefined,
    headers: {},
    method,
  } as Partial<AuthenticatedRequest> as AuthenticatedRequest;
}
