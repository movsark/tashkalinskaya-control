import type { ExecutionContext } from "@nestjs/common";
import { ForbiddenException } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import { describe, expect, it, vi } from "vitest";

import { RolesGuard, StepUpGuard } from "./identity.guards";
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
