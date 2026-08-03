import type { RoleCode } from "@tashkalinskaya/contracts";

export function homeRouteFor(roles: readonly RoleCode[]): string {
  void roles;
  return "/";
}
