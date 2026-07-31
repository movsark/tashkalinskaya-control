import { randomUUID } from "node:crypto";

import { BadRequestException, ConflictException, Injectable } from "@nestjs/common";
import type { EmployeeListResponse, EmployeeSummary } from "@tashkalinskaya/contracts";

import type {
  CreateEmployeeDto,
  ReplaceRolesDto,
  RevokeDeviceDto,
  RoleInputDto,
  UpdateEmployeeStatusDto,
} from "./identity.dto";
import { IdentityCryptoService } from "./identity-crypto.service";
import { IdentityRepository } from "./identity.repository";

@Injectable()
export class EmployeesService {
  constructor(
    private readonly crypto: IdentityCryptoService,
    private readonly repository: IdentityRepository,
  ) {}

  async list(): Promise<EmployeeListResponse> {
    const items = await this.repository.listEmployees();
    return { items, total: items.length };
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

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}
