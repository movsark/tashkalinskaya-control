import { randomUUID } from "node:crypto";

import { ForbiddenException, Injectable, UnprocessableEntityException } from "@nestjs/common";
import type {
  AttendanceControlView,
  AttendanceCorrectionView,
  AttendanceDepartmentOption,
  AttendanceQrView,
  AttendanceScanResult,
  AttendanceSetupView,
  AttendanceShiftOption,
  EmployeeAttendanceAssignmentView,
  ManualAttendanceReasonView,
  ManualAttendanceResult,
} from "@tashkalinskaya/contracts";

import type { AuthenticatedActor, AuthenticatedTerminal } from "../identity/identity.types";
import { AttendanceCryptoService } from "./attendance-crypto.service";
import { AttendanceRepository } from "./attendance.repository";
import type {
  AttendanceControlQueryDto,
  AttendanceCorrectionQueryDto,
  AssignEmployeeAttendanceDto,
  CreateAttendanceDepartmentDto,
  CreateAttendanceCorrectionDto,
  CreateAttendanceShiftDto,
  DecideAttendanceCorrectionDto,
  ManualAttendanceDto,
  ScanAttendanceQrDto,
} from "./attendance.dto";

@Injectable()
export class AttendanceService {
  constructor(
    private readonly crypto: AttendanceCryptoService,
    private readonly repository: AttendanceRepository,
  ) {}

  setup(): Promise<AttendanceSetupView> {
    return this.repository.getSetup();
  }

  async createDepartment(
    dto: CreateAttendanceDepartmentDto,
    actor: AuthenticatedActor,
    correlationId: string,
  ): Promise<AttendanceDepartmentOption> {
    try {
      return await this.repository.createDepartment({
        actor,
        correlationId,
        departmentId: randomUUID(),
        name: dto.name.trim(),
      });
    } catch (error) {
      throw mapAttendanceError(error);
    }
  }

  async createShift(
    dto: CreateAttendanceShiftDto,
    actor: AuthenticatedActor,
    correlationId: string,
  ): Promise<AttendanceShiftOption> {
    if (!dto.crossesMidnight && dto.endLocalTime <= dto.startLocalTime) {
      throw new UnprocessableEntityException({
        code: "SHIFT_TIME_INVALID",
        message: "Время окончания дневной смены должно быть позже начала",
      });
    }
    try {
      return await this.repository.createShift({
        actor,
        correlationId,
        crossesMidnight: dto.crossesMidnight,
        departmentId: dto.departmentId,
        endLocalTime: dto.endLocalTime,
        name: dto.name.trim(),
        shiftTemplateId: randomUUID(),
        startLocalTime: dto.startLocalTime,
      });
    } catch (error) {
      throw mapAttendanceError(error);
    }
  }

  assignment(employeeId: string): Promise<EmployeeAttendanceAssignmentView> {
    return this.repository.getEmployeeAssignment(employeeId).catch((error: unknown) => {
      throw mapAttendanceError(error);
    });
  }

  async assignEmployee(
    employeeId: string,
    dto: AssignEmployeeAttendanceDto,
    actor: AuthenticatedActor,
    correlationId: string,
  ): Promise<EmployeeAttendanceAssignmentView> {
    try {
      return await this.repository.assignEmployee({
        actor,
        correlationId,
        departmentId: dto.departmentId,
        employeeId,
        shiftTemplateId: dto.shiftTemplateId,
      });
    } catch (error) {
      throw mapAttendanceError(error);
    }
  }

  control(
    query: AttendanceControlQueryDto,
    actor: AuthenticatedActor,
  ): Promise<AttendanceControlView> {
    const scope = attendanceViewScope(actor, query.departmentId);
    return this.repository.getControl({
      ...(query.date === undefined ? {} : { businessDate: query.date }),
      departmentIds: scope.departmentIds,
      ...(scope.requestedDepartmentId === undefined
        ? {}
        : { requestedDepartmentId: scope.requestedDepartmentId }),
    });
  }

  listManualReasons(actor: AuthenticatedActor): Promise<readonly ManualAttendanceReasonView[]> {
    if (
      !hasManualRole(actor) &&
      !actor.roles.some(
        (role) =>
          role.roleCode === "ACCOUNTANT" && role.scopeType === "FACTORY" && role.scopeId === null,
      )
    )
      throw accessDenied();
    return this.repository.listManualReasons();
  }

  async recordManual(
    dto: ManualAttendanceDto,
    actor: AuthenticatedActor,
    correlationId: string,
  ): Promise<ManualAttendanceResult> {
    if (!hasManualRole(actor)) throw accessDenied();
    try {
      return await this.repository.recordManual({
        actor,
        ...(dto.comment === undefined ? {} : { comment: dto.comment }),
        correlationId,
        employeeId: dto.employeeId,
        idempotencyKey: dto.idempotencyKey,
        reasonId: dto.reasonId,
      });
    } catch (error) {
      const coded = error as { code?: unknown; message?: unknown };
      if (coded.code === "ACCESS_DENIED") throw accessDenied();
      if (typeof coded.code === "string" && typeof coded.message === "string") {
        throw new UnprocessableEntityException({ code: coded.code, message: coded.message });
      }
      throw error;
    }
  }

  listCorrections(
    query: AttendanceCorrectionQueryDto,
    actor: AuthenticatedActor,
  ): Promise<readonly AttendanceCorrectionView[]> {
    requireFactoryRole(actor, ["ACCOUNTANT", "ADMIN", "MANAGER"]);
    return this.repository.listCorrections({
      departmentIds: null,
      ...(query.status === undefined ? {} : { status: query.status }),
    });
  }

  async createCorrection(
    dto: CreateAttendanceCorrectionDto,
    actor: AuthenticatedActor,
    correlationId: string,
  ): Promise<AttendanceCorrectionView> {
    requireFactoryRole(actor, ["ACCOUNTANT", "ADMIN"]);
    try {
      return await this.repository.createCorrection({
        actor,
        ...(dto.comment === undefined ? {} : { comment: dto.comment }),
        correlationId,
        proposedEffectiveAt: new Date(dto.proposedEffectiveAt),
        proposedEventType: dto.proposedEventType,
        reasonId: dto.reasonId,
        workShiftId: dto.workShiftId,
      });
    } catch (error) {
      throw mapAttendanceError(error);
    }
  }

  async decideCorrection(
    correctionId: string,
    dto: DecideAttendanceCorrectionDto,
    actor: AuthenticatedActor,
    correlationId: string,
  ): Promise<AttendanceCorrectionView> {
    requireFactoryRole(actor, ["ADMIN"]);
    try {
      return await this.repository.decideCorrection({
        actor,
        comment: dto.comment,
        correlationId,
        correctionId,
        decision: dto.decision,
      });
    } catch (error) {
      throw mapAttendanceError(error);
    }
  }

  async issueQr(actor: AuthenticatedActor): Promise<AttendanceQrView> {
    const secret = this.crypto.generateSecret();
    try {
      const token = await this.repository.issueToken({
        actor,
        tokenHash: this.crypto.hashSecret(secret),
        tokenId: randomUUID(),
      });
      return {
        acceptUntil: token.acceptUntil.toISOString(),
        action: token.action,
        businessDate: token.businessDate,
        issuedAt: token.issuedAt.toISOString(),
        lastEvent: token.lastEvent,
        payload: `tkc:a1:${secret}`,
        visibleUntil: token.visibleUntil.toISOString(),
      };
    } catch (error) {
      const coded = error as { code?: unknown; message?: unknown };
      if (typeof coded.code === "string" && typeof coded.message === "string") {
        throw new UnprocessableEntityException({ code: coded.code, message: coded.message });
      }
      throw error;
    }
  }

  async scan(
    dto: ScanAttendanceQrDto,
    terminal: AuthenticatedTerminal,
    correlationId: string,
  ): Promise<AttendanceScanResult> {
    const secret = dto.payload.slice("tkc:a1:".length);
    const outcome = await this.repository.scanToken({
      correlationId,
      idempotencyKey: dto.idempotencyKey,
      terminal,
      tokenHash: this.crypto.hashSecret(secret),
    });
    if (!outcome.ok) {
      throw new UnprocessableEntityException({ code: outcome.code, message: outcome.message });
    }
    return outcome.result;
  }
}

function attendanceViewScope(
  actor: AuthenticatedActor,
  requestedDepartmentId: string | undefined,
): { departmentIds: readonly string[] | null; requestedDepartmentId?: string } {
  const hasFactoryView = actor.roles.some(
    (role) =>
      ["ACCOUNTANT", "ADMIN", "MANAGER"].includes(role.roleCode) &&
      role.scopeType === "FACTORY" &&
      role.scopeId === null,
  );
  if (hasFactoryView) {
    return {
      departmentIds: null,
      ...(requestedDepartmentId === undefined ? {} : { requestedDepartmentId }),
    };
  }
  const departmentIds = actor.roles
    .filter(
      (role) =>
        role.roleCode === "WORKSHOP_MANAGER" &&
        role.scopeType === "WORKSHOP" &&
        role.scopeId !== null,
    )
    .map((role) => role.scopeId as string);
  if (
    departmentIds.length === 0 ||
    (requestedDepartmentId !== undefined && !departmentIds.includes(requestedDepartmentId))
  ) {
    throw accessDenied();
  }
  return {
    departmentIds,
    ...(requestedDepartmentId === undefined ? {} : { requestedDepartmentId }),
  };
}

function hasManualRole(actor: AuthenticatedActor): boolean {
  return actor.roles.some(
    (role) =>
      (role.roleCode === "ADMIN" && role.scopeType === "FACTORY" && role.scopeId === null) ||
      (role.roleCode === "WORKSHOP_MANAGER" &&
        role.scopeType === "WORKSHOP" &&
        role.scopeId !== null),
  );
}

function accessDenied(): ForbiddenException {
  return new ForbiddenException({
    code: "ACCESS_DENIED",
    message: "Недостаточно прав для табеля выбранного подразделения",
  });
}

function requireFactoryRole(
  actor: AuthenticatedActor,
  allowed: ReadonlyArray<"ACCOUNTANT" | "ADMIN" | "MANAGER">,
): void {
  const accepted = actor.roles.some(
    (role) =>
      allowed.includes(role.roleCode as "ACCOUNTANT" | "ADMIN" | "MANAGER") &&
      role.scopeType === "FACTORY" &&
      role.scopeId === null,
  );
  if (!accepted) throw accessDenied();
}

function mapAttendanceError(error: unknown): Error {
  const coded = error as { code?: unknown; message?: unknown };
  if (coded.code === "ACCESS_DENIED") return accessDenied();
  if (typeof coded.code === "string" && typeof coded.message === "string") {
    return new UnprocessableEntityException({ code: coded.code, message: coded.message });
  }
  return error instanceof Error ? error : new Error("Attendance operation failed");
}
