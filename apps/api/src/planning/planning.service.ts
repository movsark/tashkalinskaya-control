import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { RoleCode } from "@tashkalinskaya/contracts";

import type {
  CreateCalendarLinkDto,
  CreateNormRequestDto,
  DecideNormRequestDto,
  OverrideProductionPlanDto,
  RunProductionPlanDto,
  SaveTerritoryDailyNormDto,
} from "./planning.dto";
import { PlanningRepository } from "./planning.repository";
import { API_CONFIG, type ApiConfig } from "../config";

@Injectable()
export class PlanningService {
  constructor(
    private readonly repository: PlanningRepository,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  setup() {
    return this.repository.getSetup();
  }

  async week(
    territoryId: string,
    weekStart: string,
    actorEmployeeId: string,
    roles: readonly RoleCode[],
  ) {
    assertDate(weekStart);
    if (isoWeekday(weekStart) !== 1)
      throw new BadRequestException("Неделя должна начинаться с понедельника");
    if (!roles.some((role) => ["ADMIN", "MANAGER", "WAREHOUSE_KEEPER"].includes(role))) {
      const allowed = await this.repository.canDriverViewTerritory(
        actorEmployeeId,
        territoryId,
        weekStart,
      );
      if (!allowed) throw new ForbiddenException("Нормы другой территории недоступны");
    }
    return this.repository.getWeek(territoryId, weekStart);
  }

  requests() {
    return this.repository.listRequests();
  }

  territoryDailyNorm(territoryId: string, dispatchDate: string) {
    assertDate(dispatchDate);
    return this.repository.getTerritoryDailyNorm(territoryId, dispatchDate);
  }

  saveTerritoryDailyNorm(
    territoryId: string,
    dto: SaveTerritoryDailyNormDto,
    actorEmployeeId: string,
    correlationId: string,
  ) {
    assertDate(dto.dispatchDate);
    if (new Set(dto.lines.map((line) => line.productId)).size !== dto.lines.length) {
      throw new BadRequestException("Один товар указан несколько раз");
    }
    return this.repository.saveTerritoryDailyNorm({
      actorEmployeeId,
      correlationId,
      dispatchDate: dto.dispatchDate,
      lines: dto.lines,
      reason: dto.reason.trim(),
      territoryId,
    });
  }

  createRequest(dto: CreateNormRequestDto, actorEmployeeId: string, correlationId: string) {
    const productIds = new Set(dto.lines.map((line) => line.productId));
    if (productIds.size !== dto.lines.length)
      throw new BadRequestException("Один товар указан несколько раз");
    if (dto.kind === "PERMANENT") {
      if (
        dto.dispatchWeekday === undefined ||
        dto.effectiveFrom === undefined ||
        dto.dispatchDate !== undefined
      ) {
        throw new BadRequestException("Для постоянной нормы нужны день недели и дата начала");
      }
      assertDate(dto.effectiveFrom);
    } else {
      if (
        dto.dispatchDate === undefined ||
        dto.dispatchWeekday !== undefined ||
        dto.effectiveFrom !== undefined
      ) {
        throw new BadRequestException("Для разовой нормы нужна только дата вывоза");
      }
      assertDate(dto.dispatchDate);
    }
    return this.repository.createRequest({
      activeRole: "DRIVER",
      actorEmployeeId,
      comment: cleanOptional(dto.comment),
      correlationId,
      dispatchDate: dto.dispatchDate ?? null,
      dispatchWeekday: dto.dispatchWeekday ?? null,
      effectiveFrom: dto.effectiveFrom ?? null,
      kind: dto.kind,
      lines: dto.lines,
      territoryId: dto.territoryId,
    });
  }

  decideRequest(
    requestId: string,
    dto: DecideNormRequestDto,
    actorEmployeeId: string,
    correlationId: string,
  ) {
    return this.repository.decideRequest({
      actorEmployeeId,
      comment: dto.comment.trim(),
      correlationId,
      decision: dto.decision,
      requestId,
      version: dto.version,
    });
  }

  createCalendarLink(dto: CreateCalendarLinkDto, actorEmployeeId: string, correlationId: string) {
    assertDate(dto.productionDate);
    assertDate(dto.dispatchDate);
    const productionWeekday = isoWeekday(dto.productionDate);
    const dispatchWeekday = isoWeekday(dto.dispatchDate);
    if (productionWeekday === 4 && dto.exceptionType === "STANDARD") {
      throw new BadRequestException("Четверг закрыт для производства; создайте явное исключение");
    }
    if (dispatchWeekday === 5 && dto.territoryId === undefined) {
      throw new BadRequestException("Пятничный вывоз разрешается только отдельной территории");
    }
    const cutoff = new Date(dto.cutoffAt);
    const productionStart = new Date(`${dto.productionDate}T00:00:00+03:00`);
    if (cutoff >= productionStart)
      throw new BadRequestException("Отсечка должна быть раньше даты производства");
    return this.repository.createCalendarLink({
      actorEmployeeId,
      comment: dto.comment.trim(),
      correlationId,
      cutoffAt: dto.cutoffAt,
      dispatchDate: dto.dispatchDate,
      exceptionType: dto.exceptionType,
      productionDate: dto.productionDate,
      reasonCode: dto.reasonCode.trim().toUpperCase(),
      territoryId: dto.territoryId ?? null,
    });
  }

  async runProductionPlan(
    productionDate: string,
    dto: RunProductionPlanDto,
    actorEmployeeId: string,
    correlationId: string,
  ) {
    assertDate(productionDate);
    void dto.idempotencyKey;
    const result = await this.repository.runProductionPlan({
      actorEmployeeId,
      allowPlaceholderInputs: this.allowsPlaceholderInputs(),
      correlationId,
      productionDate,
    });
    if (result.status === "FAILED") {
      throw new ConflictException({ code: result.code, message: planErrorMessage(result.code) });
    }
    return result;
  }

  async productionPlan(productionDate: string) {
    assertDate(productionDate);
    const plan = await this.repository.getProductionPlan(productionDate);
    if (plan === null) throw new NotFoundException("План на эту дату еще не опубликован");
    return plan;
  }

  overrideProductionPlan(
    productionDate: string,
    dto: OverrideProductionPlanDto,
    actorEmployeeId: string,
    correlationId: string,
  ) {
    assertDate(productionDate);
    return this.repository.overrideProductionPlan({
      actorEmployeeId,
      correlationId,
      idempotencyKey: dto.idempotencyKey,
      newQuantity: dto.quantity,
      productId: dto.productId,
      productionDate,
      reason: dto.reason.trim(),
    });
  }

  private allowsPlaceholderInputs(): boolean {
    // B14 provides a safe system-ledger fallback with an explicit warning when
    // the physical inventory has not been submitted by 10:00.
    return true;
  }
}

function planErrorMessage(code: string): string {
  const messages: Record<string, string> = {
    CALENDAR_OR_DEMAND_MISSING: "Не найден календарь вывоза или утвержденный спрос",
    PLACEHOLDER_INPUTS_DISABLED:
      "План нельзя публиковать без подключенных заказов магазина и складских остатков",
    PRODUCT_WORKSHOP_MISSING: "У одного из товаров не назначен основной цех",
  };
  return messages[code] ?? "План не прошел предварительную проверку";
}

function assertDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new BadRequestException("Неверный формат даты");
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new BadRequestException("Недопустимая дата");
  }
}

function isoWeekday(value: string): number {
  const day = new Date(`${value}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

function cleanOptional(value: string | undefined): string | null {
  const cleaned = value?.trim() ?? "";
  return cleaned === "" ? null : cleaned;
}
