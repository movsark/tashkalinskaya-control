import { randomUUID } from "node:crypto";

import { BadRequestException, ConflictException, Injectable } from "@nestjs/common";

import type {
  CreateExtraRunDto,
  CreateDriverTerritoryRequestDto,
  CreateDefaultAssignmentDto,
  CreateLoadingGroupDto,
  CreateVehicleDto,
  DecideDriverTerritoryRequestDto,
  GenerateDayDto,
  MarkRunReadyDto,
  PublishDayDto,
  SelectDriverHomeTerritoryDto,
  UpdateRunAssignmentDto,
  UpdateTerritoryDto,
  UpdateVehicleDto,
  UpsertDriverProfileDto,
} from "./logistics.dto";
import { LogisticsRepository } from "./logistics.repository";

@Injectable()
export class LogisticsService {
  constructor(private readonly repository: LogisticsRepository) {}

  setup() {
    return this.repository.getSetup();
  }

  day(dispatchDate: string) {
    assertDate(dispatchDate);
    return this.repository.getDay(dispatchDate);
  }

  driverDay(dispatchDate: string, driverEmployeeId: string) {
    assertDate(dispatchDate);
    return this.repository.getDriverDay(dispatchDate, driverEmployeeId);
  }

  selectDriverHomeTerritory(
    dto: SelectDriverHomeTerritoryDto,
    actorEmployeeId: string,
    correlationId: string,
  ) {
    return this.withConflictMapping(() =>
      this.repository.selectDriverHomeTerritory({
        actorEmployeeId,
        correlationId,
        territoryId: dto.territoryId,
        version: dto.version,
      }),
    );
  }

  warehouseDay(dispatchDate: string) {
    assertDate(dispatchDate);
    return this.repository.getWarehouseDay(dispatchDate);
  }

  updateTerritory(
    territoryId: string,
    dto: UpdateTerritoryDto,
    actorEmployeeId: string,
    correlationId: string,
  ) {
    return this.withConflictMapping(() =>
      this.repository.updateTerritory({
        actorEmployeeId,
        correlationId,
        description: cleanOptional(dto.description),
        name: dto.name.trim(),
        status: dto.status,
        territoryId,
        version: dto.version,
      }),
    );
  }

  createVehicle(dto: CreateVehicleDto, actorEmployeeId: string, correlationId: string) {
    return this.withConflictMapping(() =>
      this.repository.createVehicle({
        actorEmployeeId,
        capacityNote: cleanOptional(dto.capacityNote),
        comment: cleanOptional(dto.comment),
        correlationId,
        displayName: dto.displayName.trim(),
        registrationNumber: dto.registrationNumber.trim().toUpperCase(),
        registrationNumberNormalized: normalizeRegistration(dto.registrationNumber),
        vehicleId: randomUUID(),
      }),
    );
  }

  updateVehicle(
    vehicleId: string,
    dto: UpdateVehicleDto,
    actorEmployeeId: string,
    correlationId: string,
  ) {
    return this.withConflictMapping(() =>
      this.repository.updateVehicle({
        actorEmployeeId,
        capacityNote: cleanOptional(dto.capacityNote),
        comment: cleanOptional(dto.comment),
        correlationId,
        displayName: dto.displayName.trim(),
        registrationNumber: dto.registrationNumber.trim().toUpperCase(),
        registrationNumberNormalized: normalizeRegistration(dto.registrationNumber),
        status: dto.status,
        vehicleId,
        version: dto.version,
      }),
    );
  }

  upsertDriver(
    employeeId: string,
    dto: UpsertDriverProfileDto,
    actorEmployeeId: string,
    correlationId: string,
  ) {
    if (dto.canDriveFrom !== undefined && dto.canDriveTo !== undefined) {
      if (dto.canDriveTo < dto.canDriveFrom) {
        throw new BadRequestException("Дата окончания допуска раньше даты начала");
      }
    }
    return this.withConflictMapping(() =>
      this.repository.upsertDriver({
        actorEmployeeId,
        canDriveFrom: dto.canDriveFrom ?? null,
        canDriveTo: dto.canDriveTo ?? null,
        comment: cleanOptional(dto.comment),
        correlationId,
        employeeId,
        status: dto.status,
        version: dto.version ?? null,
      }),
    );
  }

  createDefaultAssignment(
    dto: CreateDefaultAssignmentDto,
    actorEmployeeId: string,
    correlationId: string,
  ) {
    if (dto.validTo !== undefined && dto.validTo < dto.validFrom) {
      throw new BadRequestException("Окончание закрепления раньше даты начала");
    }
    return this.withConflictMapping(() =>
      this.repository.createDefaultAssignment({
        actorEmployeeId,
        assignmentId: randomUUID(),
        comment: cleanOptional(dto.comment),
        correlationId,
        driverEmployeeId: dto.driverEmployeeId,
        reasonCode: dto.reasonCode.trim().toUpperCase(),
        territoryId: dto.territoryId,
        validFrom: dto.validFrom,
        validTo: dto.validTo ?? null,
        vehicleId: dto.vehicleId,
      }),
    );
  }

  generateDay(
    dispatchDate: string,
    dto: GenerateDayDto,
    actorEmployeeId: string,
    correlationId: string,
  ) {
    assertDate(dispatchDate);
    return this.withConflictMapping(() =>
      this.repository.generateDay({
        actorEmployeeId,
        correlationId,
        dispatchDate,
        idempotencyKey: dto.idempotencyKey,
      }),
    );
  }

  createGroup(dto: CreateLoadingGroupDto, actorEmployeeId: string, correlationId: string) {
    if (new Date(dto.plannedEndAt) <= new Date(dto.plannedStartAt)) {
      throw new BadRequestException("Окончание группы должно быть позже начала");
    }
    return this.withConflictMapping(() =>
      this.repository.createGroup({
        actorEmployeeId,
        correlationId,
        dispatchDate: dto.dispatchDate,
        groupId: randomUUID(),
        groupNo: dto.groupNo,
        loadingZone: dto.loadingZone.trim().toUpperCase(),
        plannedEndAt: dto.plannedEndAt,
        plannedStartAt: dto.plannedStartAt,
      }),
    );
  }

  updateRun(
    runId: string,
    dto: UpdateRunAssignmentDto,
    actorEmployeeId: string,
    correlationId: string,
  ) {
    if (new Date(dto.plannedEndAt) <= new Date(dto.plannedStartAt)) {
      throw new BadRequestException("Окончание рейса должно быть позже начала");
    }
    return this.withConflictMapping(() =>
      this.repository.updateRun({
        actorEmployeeId,
        comment: cleanOptional(dto.comment),
        correlationId,
        driverEmployeeId: dto.driverEmployeeId,
        loadingGroupId: dto.loadingGroupId ?? null,
        plannedEndAt: dto.plannedEndAt,
        plannedStartAt: dto.plannedStartAt,
        reasonCode: dto.reasonCode.trim().toUpperCase(),
        runId,
        sequenceNo: dto.sequenceNo ?? null,
        vehicleId: dto.vehicleId,
        version: dto.version,
      }),
    );
  }

  publishDay(
    dispatchDate: string,
    dto: PublishDayDto,
    actorEmployeeId: string,
    correlationId: string,
  ) {
    assertDate(dispatchDate);
    return this.withConflictMapping(() =>
      this.repository.publishDay({
        actorEmployeeId,
        correlationId,
        dispatchDate,
        runIds: [...new Set(dto.runIds)],
      }),
    );
  }

  markRunReady(
    runId: string,
    dto: MarkRunReadyDto,
    actorEmployeeId: string,
    activeRole: "ADMIN" | "WAREHOUSE_KEEPER",
    correlationId: string,
  ) {
    return this.withConflictMapping(() =>
      this.repository.markRunReady({
        activeRole,
        actorEmployeeId,
        correlationId,
        idempotencyKey: dto.idempotencyKey,
        runId,
        version: dto.version,
      }),
    );
  }

  createExtraRun(dto: CreateExtraRunDto, actorEmployeeId: string, correlationId: string) {
    assertDate(dto.dispatchDate);
    return this.withConflictMapping(() =>
      this.repository.createExtraRun({
        actorEmployeeId,
        comment: dto.comment.trim(),
        correlationId,
        dispatchDate: dto.dispatchDate,
        idempotencyKey: dto.idempotencyKey,
        reasonCode: dto.reasonCode.trim().toUpperCase(),
        territoryId: dto.territoryId,
      }),
    );
  }

  createDriverTerritoryRequest(
    dto: CreateDriverTerritoryRequestDto,
    actorEmployeeId: string,
    correlationId: string,
  ) {
    assertDate(dto.dispatchDate);
    return this.withConflictMapping(() =>
      this.repository.createDriverTerritoryRequest({
        actorEmployeeId,
        correlationId,
        dispatchDate: dto.dispatchDate,
        reason: dto.reason.trim(),
        requestId: randomUUID(),
        territoryId: dto.territoryId,
      }),
    );
  }

  decideDriverTerritoryRequest(
    requestId: string,
    dto: DecideDriverTerritoryRequestDto,
    actorEmployeeId: string,
    correlationId: string,
  ) {
    return this.withConflictMapping(() =>
      this.repository.decideDriverTerritoryRequest({
        actorEmployeeId,
        comment: dto.comment.trim(),
        correlationId,
        decision: dto.decision,
        requestId,
        version: dto.version,
      }),
    );
  }

  private async withConflictMapping<Result>(operation: () => Promise<Result>): Promise<Result> {
    try {
      return await operation();
    } catch (error) {
      const code = databaseErrorCode(error);
      if (code === "23505") {
        throw new ConflictException({
          code: "LOGISTICS_DUPLICATE",
          message: "Такая запись уже существует",
        });
      }
      if (code === "23P01") {
        throw new ConflictException({
          code: "LOGISTICS_TIME_CONFLICT",
          message: "Пересекаются закрепления, водитель, машина или время рейсов",
        });
      }
      if (code === "23503" || code === "23514") {
        throw new BadRequestException({
          code: "LOGISTICS_INVALID_REFERENCE",
          message: "Проверьте выбранные объекты, даты и статусы",
        });
      }
      throw error;
    }
  }
}

function cleanOptional(value: string | undefined): string | null {
  const cleaned = value?.trim() ?? "";
  return cleaned === "" ? null : cleaned;
}

function normalizeRegistration(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]/gu, "")
    .toUpperCase();
}

function databaseErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function assertDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new BadRequestException("Дата должна быть в формате ГГГГ-ММ-ДД");
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new BadRequestException("Указана недопустимая дата");
  }
}
