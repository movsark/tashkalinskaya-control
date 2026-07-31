import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { DeviceSecurityRepository } from "./device-security.repository";
import { EmployeesService } from "./employees.service";
import { IdentityCryptoService } from "./identity-crypto.service";
import { IdentityRepository } from "./identity.repository";

function createService() {
  const repository = {
    replaceRoles: vi.fn().mockResolvedValue({ id: "employee-1" }),
  };
  const service = new EmployeesService(
    {} as IdentityCryptoService,
    {} as DeviceSecurityRepository,
    repository as unknown as IdentityRepository,
  );
  return { repository, service };
}

describe("EmployeesService role boundaries", () => {
  it("rejects a workshop role assigned to the whole factory", async () => {
    const { repository, service } = createService();

    await expect(
      service.replaceRoles(
        "employee-1",
        {
          reason: "Проверка границы",
          roles: [{ roleCode: "CONFECTIONER", scopeType: "FACTORY" }],
          version: 1,
        },
        "admin-1",
        "correlation-1",
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.replaceRoles).not.toHaveBeenCalled();
  });

  it("accepts a workshop role only with a concrete workshop scope", async () => {
    const { repository, service } = createService();

    await service.replaceRoles(
      "employee-1",
      {
        reason: "Назначение в цех",
        roles: [
          {
            roleCode: "WORKSHOP_MANAGER",
            scopeId: "11111111-1111-4111-8111-111111111111",
            scopeType: "WORKSHOP",
          },
        ],
        version: 1,
      },
      "admin-1",
      "correlation-2",
    );

    expect(repository.replaceRoles).toHaveBeenCalledOnce();
  });
});
