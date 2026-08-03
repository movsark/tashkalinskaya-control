import type { RoleCode } from "@tashkalinskaya/contracts";

export function homeRouteFor(roles: readonly RoleCode[]): string {
  if (roles.includes("ADMIN")) return "/employees";
  if (roles.some((role) => ["ACCOUNTANT", "MANAGER", "WORKSHOP_MANAGER"].includes(role))) {
    return "/attendance/control";
  }
  return "/attendance/me";
}
