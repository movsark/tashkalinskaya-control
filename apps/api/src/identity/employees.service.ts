import { randomUUID } from "node:crypto";

import { BadRequestException, ConflictException, Injectable } from "@nestjs/common";
import type { EmployeeListResponse, EmployeeSummary } from "@tashkalinskaya/contracts";

import type {
  CreateEmployeeDto,
  CreateEmployeeInvitationDto,
  DeleteInvitedEmployeeDto,
  IssueRecoveryDto,
  ReplaceRolesDto,
  RevokeDeviceDto,
  RoleInputDto,
  UpdateEmployeeStatusDto,
  UpdateEmployeeProfileDto,
} from "./identity.dto";
import { DeviceSecurityRepository } from "./device-security.repository";
import { IdentityCryptoService } from "./identity-crypto.service";
import { IdentityRepository } from "./identity.repository";

@Injectable()
export class EmployeesService {
  constructor(
    private readonly crypto: IdentityCryptoService,
    private readonly deviceSecurity: DeviceSecurityRepository,
    private readonly repository: IdentityRepository,
  ) {}

  async list(): Promise<EmployeeListResponse> {
    const items = await this.repository.listEmployees();
    return { items, total: items.length };
  }

  access(employeeId: string) {
    return this.repository.getEmployeeAccess(employeeId);
  }

  async create(
    dto: CreateEmployeeDto,
    actorEmployeeId: string,
    correlationId: string,
  ): Promise<{ activationCode: string; employee: EmployeeSummary; expiresAt: string }> {
    const roles = normalizeRoles(dto.roles);
    const activationCode = this.crypto.generateAccessCode();
    const employeeId = randomUUID();

    try {
      const employee = await this.repository.createEmployee({
        actorEmployeeId,
        correlationId,
        ...(dto.departmentId === undefined ? {} : { departmentId: dto.departmentId }),
        employeeId,
        fullName: dto.fullName.trim(),
        loginNormalized: this.crypto.normalizeLogin(dto.login),
        personnelNumber: dto.personnelNumber.trim(),
        personnelNumberNormalized: this.crypto.normalizePersonnelNumber(dto.personnelNumber),
        roleAssignments: roles.map((role) => ({ id: randomUUID(), ...role })),
        tokenHash: this.crypto.hashAccessCode(activationCode),
        tokenId: randomUUID(),
      });
      return {
        activationCode,
        employee,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      };
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException({
          code: "EMPLOYEE_ALREADY_EXISTS",
          message: "Логин или табельный номер уже используется",
        });
      }
      throw error;
    }
  }

  invitationOptions() {
    return this.repository.employeeInvitationOptions();
  }

  async createInvitation(
    dto: CreateEmployeeInvitationDto,
    actorEmployeeId: string,
    correlationId: string,
  ) {
    const role = normalizeRoles([dto.role])[0]!;
    const invitationCode = this.crypto.generateAccessCode();
    const invitation = await this.repository.createEmployeeInvitation({
      actorEmployeeId,
      correlationId,
      id: randomUUID(),
      roleCode: role.roleCode,
      scopeId: role.scopeId,
      scopeType: role.scopeType,
      tokenHash: this.crypto.hashAccessCode(invitationCode),
    });
    return {
      expiresAt: invitation.expiresAt.toISOString(),
      invitationCode,
      roleCode: invitation.roleCode,
      roleDisplayName: invitation.roleDisplayName,
      scopeDisplayName: invitation.scopeDisplayName,
    };
  }

  async updateStatus(
    employeeId: string,
    dto: UpdateEmployeeStatusDto,
    actorEmployeeId: string,
    correlationId: string,
  ): Promise<EmployeeSummary> {
    return this.repository.updateEmployeeStatus({
      actorEmployeeId,
      correlationId,
      employeeId,
      reason: dto.reason.trim(),
      status: dto.status,
      version: dto.version,
    });
  }

  async updateProfile(
    employeeId: string,
    dto: UpdateEmployeeProfileDto,
    actorEmployeeId: string,
    correlationId: string,
  ): Promise<EmployeeSummary> {
    try {
      return await this.repository.updateEmployeeProfile({
        actorEmployeeId,
        correlationId,
        employeeId,
        fullName: dto.fullName.trim(),
        loginNormalized: this.crypto.normalizeLogin(dto.login),
        personnelNumber: dto.personnelNumber.trim(),
        personnelNumberNormalized: this.crypto.normalizePersonnelNumber(dto.personnelNumber),
        reason: dto.reason.trim(),
        version: dto.version,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException({
          code: "EMPLOYEE_ALREADY_EXISTS",
          message: "Логин или табельный номер уже используется",
        });
      }
      throw error;
    }
  }

  async deleteInvitedEmployee(
    employeeId: string,
    dto: DeleteInvitedEmployeeDto,
    actorEmployeeId: string,
    correlationId: string,
  ): Promise<void> {
    await this.repository.deleteInvitedEmployee({
      actorEmployeeId,
      correlationId,
      employeeId,
      reason: dto.reason.trim(),
      version: dto.version,
    });
  }

  async reissueActivation(
    employeeId: string,
    dto: IssueRecoveryDto,
    actorEmployeeId: string,
    correlationId: string,
  ): Promise<{ activationCode: string; expiresAt: string }> {
    const activationCode = this.crypto.generateAccessCode();
    const result = await this.repository.reissueActivation({
      actorEmployeeId,
      correlationId,
      employeeId,
      reason: dto.reason.trim(),
      tokenHash: this.crypto.hashAccessCode(activationCode),
    });
    return { activationCode, expiresAt: result.expiresAt.toISOString() };
  }

  async replaceRoles(
    employeeId: string,
    dto: ReplaceRolesDto,
    actorEmployeeId: string,
    correlationId: string,
  ): Promise<EmployeeSummary> {
    return this.repository.replaceRoles({
      actorEmployeeId,
      correlationId,
      employeeId,
      reason: dto.reason.trim(),
      roles: normalizeRoles(dto.roles).map((role) => ({ id: randomUUID(), ...role })),
      version: dto.version,
    });
  }

  async revokeDevice(
    deviceId: string,
    dto: RevokeDeviceDto,
    actorEmployeeId: string,
    correlationId: string,
  ): Promise<void> {
    await this.repository.revokeDevice({
      actorEmployeeId,
      correlationId,
      deviceId,
      reason: dto.reason.trim(),
    });
  }

  async issueRecovery(
    employeeId: string,
    dto: IssueRecoveryDto,
    actorEmployeeId: string,
    correlationId: string,
  ): Promise<{ expiresAt: string; recoveryCode: string }> {
    const accountId = await this.deviceSecurity.findAccountIdByEmployee(employeeId);
    const recoveryCode = this.crypto.generateAccessCode();
    const result = await this.deviceSecurity.issueRecovery({
      accountId,
      actorEmployeeId,
      correlationId,
      employeeId,
      reason: dto.reason.trim(),
      tokenHash: this.crypto.hashAccessCode(recoveryCode),
    });
    return { expiresAt: result.expiresAt.toISOString(), recoveryCode };
  }
}

function normalizeRoles(roles: RoleInputDto[]) {
  const normalized = roles.map((role) => {
    const scopeId = role.scopeId ?? null;
    if (role.scopeType === "FACTORY" && scopeId !== null) {
      throw new BadRequestException("Для области фабрики scopeId не указывается");
    }
    if (role.scopeType !== "FACTORY" && scopeId === null) {
      throw new BadRequestException("Для ограниченной области требуется scopeId");
    }
    const allowedScopes = roleScopes[role.roleCode];
    if (!allowedScopes.includes(role.scopeType)) {
      throw new BadRequestException(
        `Роль ${role.roleCode} не может иметь область ${role.scopeType}`,
      );
    }
    return {
      roleCode: role.roleCode,
      scopeId,
      scopeType: role.scopeType,
    };
  });

  const keys = normalized.map(
    (role) => `${role.roleCode}:${role.scopeType}:${role.scopeId ?? "FACTORY"}`,
  );
  if (new Set(keys).size !== keys.length) {
    throw new BadRequestException("Назначения ролей не должны повторяться");
  }
  return normalized;
}

const roleScopes: Record<RoleInputDto["roleCode"], ReadonlyArray<RoleInputDto["scopeType"]>> = {
  ACCOUNTANT: ["FACTORY"],
  ADMIN: ["FACTORY"],
  ATTENDANCE_ONLY: ["FACTORY"],
  CONFECTIONER: ["WORKSHOP"],
  DRIVER: ["TERRITORY"],
  MANAGER: ["FACTORY"],
  STORE_SELLER: ["STORE"],
  WAREHOUSE_KEEPER: ["FACTORY", "WAREHOUSE"],
  WORKSHOP_MANAGER: ["WORKSHOP"],
};

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}
