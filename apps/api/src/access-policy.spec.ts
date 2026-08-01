import "reflect-metadata";

import { RequestMethod } from "@nestjs/common";
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { ROLE_CODES, type RoleCode } from "@tashkalinskaya/contracts";
import { describe, expect, it } from "vitest";

import { AppController } from "./app.controller";
import { AttendanceController } from "./attendance/attendance.controller";
import { CatalogController } from "./catalog/catalog.controller";
import { GoodReturnsController } from "./good-returns/good-returns.controller";
import { HealthController } from "./health.controller";
import { AuthController } from "./identity/auth.controller";
import { EmployeesController } from "./identity/employees.controller";
import { TerminalsController } from "./identity/terminals.controller";
import { InventoryController } from "./inventory/inventory.controller";
import { LoadingController } from "./loading/loading.controller";
import { LogisticsController } from "./logistics/logistics.controller";
import { NotificationsController } from "./notifications/notifications.controller";
import { PlanningController } from "./planning/planning.controller";
import { ProductionController } from "./production/production.controller";
import { ReportsController } from "./reports/reports.controller";
import { SpoilageController } from "./spoilage/spoilage.controller";
import { StoreController } from "./store/store.controller";
import { WarehouseController } from "./warehouse/warehouse.controller";

const controllers = [
  AppController,
  AttendanceController,
  AuthController,
  CatalogController,
  EmployeesController,
  GoodReturnsController,
  HealthController,
  InventoryController,
  LoadingController,
  LogisticsController,
  NotificationsController,
  PlanningController,
  ProductionController,
  ReportsController,
  SpoilageController,
  StoreController,
  TerminalsController,
  WarehouseController,
] as const;

const publicCeremonies = new Set([
  "AppController.getInfo",
  "AuthController.activate",
  "AuthController.activationOptions",
  "AuthController.login",
  "AuthController.loginOptions",
  "AuthController.recover",
  "AuthController.recoveryOptions",
  "AuthController.refresh",
  "AuthController.refreshOptions",
  "HealthController.getLiveness",
  "HealthController.getReadiness",
  "TerminalsController.login",
  "TerminalsController.loginOptions",
  "TerminalsController.pair",
  "TerminalsController.pairingOptions",
]);

const stepUpOperations = new Set([
  "AttendanceController.decideCorrection",
  "CatalogController.apply",
  "EmployeesController.create",
  "EmployeesController.issueRecovery",
  "EmployeesController.replaceRoles",
  "EmployeesController.revokeDevice",
  "EmployeesController.updateStatus",
  "TerminalsController.create",
  "TerminalsController.revoke",
]);

describe("API access policy regression", () => {
  const routes = discoverRoutes();

  it("keeps the explicit public ceremony allowlist synchronized", () => {
    const discoveredPublic = routes
      .filter((route) => !route.guards.some(isAuthenticationGuard))
      .map((route) => route.key)
      .sort();
    expect(discoveredPublic).toEqual([...publicCeremonies].sort());
  });

  it("requires authentication for every route outside the allowlist", () => {
    for (const route of routes) {
      if (publicCeremonies.has(route.key)) continue;
      expect(route.guards.some(isAuthenticationGuard), route.key).toBe(true);
    }
  });

  it("requires CSRF protection on every authenticated mutating route", () => {
    for (const route of routes) {
      if (publicCeremonies.has(route.key) || route.method === RequestMethod.GET) continue;
      expect(route.guards, route.key).toContain("CsrfGuard");
    }
  });

  it("declares a valid role set whenever RolesGuard is used", () => {
    for (const route of routes.filter((item) => item.guards.includes("RolesGuard"))) {
      expect(route.roles.length, route.key).toBeGreaterThan(0);
      expect(
        route.roles.every((role) => ROLE_CODES.includes(role)),
        route.key,
      ).toBe(true);
    }
  });

  it("keeps step-up authentication on credential and access mutations", () => {
    const protectedRoutes = routes
      .filter((route) => route.guards.includes("StepUpGuard"))
      .map((route) => route.key)
      .sort();
    expect(protectedRoutes).toEqual([...stepUpOperations].sort());
  });
});

function discoverRoutes(): readonly RoutePolicy[] {
  const routes: RoutePolicy[] = [];
  for (const controller of controllers) {
    const classGuards = guardNames(Reflect.getMetadata(GUARDS_METADATA, controller));
    for (const methodName of Object.getOwnPropertyNames(controller.prototype)) {
      if (methodName === "constructor") continue;
      const handler = controller.prototype[methodName as keyof typeof controller.prototype];
      if (typeof handler !== "function") continue;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
      const path = Reflect.getMetadata(PATH_METADATA, handler) as string | string[] | undefined;
      if (method === undefined || path === undefined) continue;
      routes.push({
        guards: [...classGuards, ...guardNames(Reflect.getMetadata(GUARDS_METADATA, handler))],
        key: `${controller.name}.${methodName}`,
        method,
        roles: (Reflect.getMetadata("required-roles", handler) as RoleCode[] | undefined) ?? [],
      });
    }
  }
  return routes;
}

function guardNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((guard: { name?: unknown }) =>
    typeof guard.name === "string" ? guard.name : "UnknownGuard",
  );
}

function isAuthenticationGuard(guard: string): boolean {
  return guard === "SessionAuthGuard" || guard === "TerminalSessionAuthGuard";
}

interface RoutePolicy {
  readonly guards: readonly string[];
  readonly key: string;
  readonly method: RequestMethod;
  readonly roles: readonly RoleCode[];
}
