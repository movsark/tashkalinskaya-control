import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { DeviceSecurityRepository } from "./device-security.repository";
import { EmployeesService } from "./employees.service";
import { IdentityCryptoService } from "./identity-crypto.service";
import { IdentityRepository } from "./identity.repository";

function createService() {
  const repository = {
    deleteInvitedEmployee: vi.fn().mockResolvedValue(undefined),
    reissueActivation: vi.fn().mockResolvedValue({
      expiresAt: new Date("2026-08-04T10:00:00.000Z"),
    }),
    replaceRoles: vi.fn().mockResolvedValue({ id: "employee-1" }),
    updateEmployeeProfile: vi.fn().mockResolvedValue({ id: "employee-1", version: 2 }),
  };
  const crypto = {
    generateAccessCode: vi.fn().mockReturnValue("new-activation-code"),
    hashAccessCode: vi.fn().mockReturnValue("new-activation-hash"),
    normalizeLogin: vi.fn((value: string) => value.trim().toLocaleLowerCase()),
    normalizePersonnelNumber: vi.fn((value: string) => value.trim().toLocaleUpperCase()),
  };
  const service = new EmployeesService(
    crypto as unknown as IdentityCryptoService,
    {} as DeviceSecurityRepository,
    repository as unknown as IdentityRepository,
  );
  return { crypto, repository, service };
}

function createInvitationService() {
  const repository = {
    createEmployeeInvitation: vi.fn().mockResolvedValue({
      expiresAt: new Date("2026-08-04T10:00:00.000Z"),
      id: "10000000-0000-4000-8000-000000000020",
      roleCode: "DRIVER",
      roleDisplayName: "Водитель",
      scopeDisplayName: "Территория 9",
      scopeId: "10000000-0000-4000-8000-000000000021",
      scopeType: "TERRITORY",
    }),
  };
  const crypto = {
    generateAccessCode: vi.fn().mockReturnValue("one-time-invitation-code"),
    hashAccessCode: vi.fn().mockReturnValue("invitation-hash"),
  };
  const service = new EmployeesService(
    crypto as unknown as IdentityCryptoService,
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

  it("normalizes editable identity fields before saving the employee profile", async () => {
    const { repository, service } = createService();

    await service.updateProfile(
      "employee-1",
      {
        fullName: "  Иванова Марина  ",
        login: "  MARINA.IVANOVA ",
        personnelNumber: "  e-101 ",
        reason: "  Исправление ошибки  ",
        version: 1,
      },
      "admin-1",
      "correlation-profile",
    );

    expect(repository.updateEmployeeProfile).toHaveBeenCalledWith({
      actorEmployeeId: "admin-1",
      correlationId: "correlation-profile",
      employeeId: "employee-1",
      fullName: "Иванова Марина",
      loginNormalized: "marina.ivanova",
      personnelNumber: "e-101",
      personnelNumberNormalized: "E-101",
      reason: "Исправление ошибки",
      version: 1,
    });
  });

  it("reissues a single-use activation code for an invited employee", async () => {
    const { repository, service } = createService();

    await expect(
      service.reissueActivation(
        "employee-1",
        { reason: "  Повторный QR  " },
        "admin-1",
        "correlation-activation",
      ),
    ).resolves.toEqual({
      activationCode: "new-activation-code",
      expiresAt: "2026-08-04T10:00:00.000Z",
    });
    expect(repository.reissueActivation).toHaveBeenCalledWith(
      expect.objectContaining({
        employeeId: "employee-1",
        reason: "Повторный QR",
        tokenHash: "new-activation-hash",
      }),
    );
  });

  it("deletes only through the invited-employee repository boundary", async () => {
    const { repository, service } = createService();

    await service.deleteInvitedEmployee(
      "employee-1",
      { reason: "  Ошибочная запись  ", version: 3 },
      "admin-1",
      "correlation-delete",
    );

    expect(repository.deleteInvitedEmployee).toHaveBeenCalledWith({
      actorEmployeeId: "admin-1",
      correlationId: "correlation-delete",
      employeeId: "employee-1",
      reason: "Ошибочная запись",
      version: 3,
    });
  });

  it("issues a one-time invitation for the administrator-selected scoped role", async () => {
    const { repository, service } = createInvitationService();

    const result = await service.createInvitation(
      {
        role: {
          roleCode: "DRIVER",
          scopeId: "10000000-0000-4000-8000-000000000021",
          scopeType: "TERRITORY",
        },
      },
      "10000000-0000-4000-8000-000000000022",
      "10000000-0000-4000-8000-000000000023",
    );

    expect(result).toMatchObject({
      invitationCode: "one-time-invitation-code",
      roleDisplayName: "Водитель",
      scopeDisplayName: "Территория 9",
    });
    expect(repository.createEmployeeInvitation).toHaveBeenCalledWith(
      expect.objectContaining({
        roleCode: "DRIVER",
        scopeId: "10000000-0000-4000-8000-000000000021",
        scopeType: "TERRITORY",
        tokenHash: "invitation-hash",
      }),
    );
  });
});
