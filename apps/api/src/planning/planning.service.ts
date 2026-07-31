import { BadRequestException, ForbiddenException, Injectable } from "@nestjs/common";
import type { RoleCode } from "@tashkalinskaya/contracts";

import type {
  CreateCalendarLinkDto,
  CreateNormRequestDto,
  DecideNormRequestDto,
} from "./planning.dto";
import { PlanningRepository } from "./planning.repository";

@Injectable()
export class PlanningService {
  constructor(private readonly repository: PlanningRepository) {}

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
