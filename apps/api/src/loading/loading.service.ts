import { BadRequestException, Injectable } from "@nestjs/common";
import type { AuthenticatedActor } from "../identity/identity.types";
import type {
  CancelLoadingLineDto,
  ConfirmLoadingSessionDto,
  CreateLoadingLineDto,
  OpenLoadingGroupDto,
  ReassignLoadingLineDto,
  ReassignTerritoryLoadingLineDto,
  RespondLoadingLineDto,
  ReviseLoadingLineDto,
  SendTerritoryLoadingLineDto,
} from "./loading.dto";
import { LoadingRepository } from "./loading.repository";

@Injectable()
export class LoadingService {
  constructor(private readonly repository: LoadingRepository) {}

  warehouseDay(date: string, actor: AuthenticatedActor) {
    assertDate(date);
    return this.repository.warehouseDay(date, toActor(actor));
  }
  driverDay(date: string, actor: AuthenticatedActor) {
    assertDate(date);
    return this.repository.driverDay(date, toActor(actor));
  }
  openGroup(id: string, dto: OpenLoadingGroupDto, actor: AuthenticatedActor, cid: string) {
    return this.repository.openGroup(id, dto.version, dto.idempotencyKey, toActor(actor), cid);
  }
  createLine(id: string, dto: CreateLoadingLineDto, actor: AuthenticatedActor, cid: string) {
    return this.repository.createLine({
      actor: toActor(actor),
      comment: dto.comment?.trim() ?? null,
      correlationId: cid,
      idempotencyKey: dto.idempotencyKey,
      productId: dto.productId,
      quantity: dto.quantity,
      sessionId: id,
      sessionVersion: dto.sessionVersion,
    });
  }
  sendToTerritory(
    territoryId: string,
    dto: SendTerritoryLoadingLineDto,
    actor: AuthenticatedActor,
    cid: string,
  ) {
    assertDate(dto.dispatchDate);
    return this.repository.sendToTerritory({
      actor: toActor(actor),
      correlationId: cid,
      dispatchDate: dto.dispatchDate,
      idempotencyKey: dto.idempotencyKey,
      productId: dto.productId,
      quantity: dto.quantity,
      territoryId,
    });
  }
  reviseLine(id: string, dto: ReviseLoadingLineDto, actor: AuthenticatedActor, cid: string) {
    return this.repository.reviseLine({
      actor: toActor(actor),
      comment: dto.comment.trim(),
      correlationId: cid,
      idempotencyKey: dto.idempotencyKey,
      lineId: id,
      quantity: dto.quantity,
      version: dto.version,
    });
  }
  reassignLine(id: string, dto: ReassignLoadingLineDto, actor: AuthenticatedActor, cid: string) {
    return this.repository.reassignLine({
      actor: toActor(actor),
      correlationId: cid,
      idempotencyKey: dto.idempotencyKey,
      lineId: id,
      reason: dto.reason.trim(),
      targetSessionId: dto.targetSessionId,
      version: dto.version,
    });
  }
  reassignLineToTerritory(
    id: string,
    dto: ReassignTerritoryLoadingLineDto,
    actor: AuthenticatedActor,
    cid: string,
  ) {
    return this.repository.reassignLineToTerritory({
      actor: toActor(actor),
      correlationId: cid,
      idempotencyKey: dto.idempotencyKey,
      lineId: id,
      reason: dto.reason.trim(),
      targetTerritoryId: dto.targetTerritoryId,
      version: dto.version,
    });
  }
  cancelLine(id: string, dto: CancelLoadingLineDto, actor: AuthenticatedActor, cid: string) {
    return this.repository.cancelLine({
      actor: toActor(actor),
      correlationId: cid,
      idempotencyKey: dto.idempotencyKey,
      lineId: id,
      reason: dto.reason.trim(),
      version: dto.version,
    });
  }
  respondLine(id: string, dto: RespondLoadingLineDto, actor: AuthenticatedActor, cid: string) {
    if (dto.responseType === "COUNTER" && dto.counterQuantity === undefined)
      throw new BadRequestException("Укажите предлагаемое количество");
    if (dto.responseType !== "COUNTER" && dto.counterQuantity !== undefined)
      throw new BadRequestException("Другое количество допустимо только для предложения");
    if (dto.responseType === "COUNTER" && (dto.reason?.trim().length ?? 0) < 3)
      throw new BadRequestException("Для другого количества нужна причина");
    const reason = dto.reason?.trim() || null;
    return this.repository.respondLine({
      actor: toActor(actor),
      correlationId: cid,
      counterQuantity: dto.counterQuantity ?? null,
      idempotencyKey: dto.idempotencyKey,
      lineId: id,
      reason,
      responseType: dto.responseType,
      revisionId: dto.revisionId,
      version: dto.version,
    });
  }
  warehouseConfirm(
    id: string,
    dto: ConfirmLoadingSessionDto,
    actor: AuthenticatedActor,
    cid: string,
  ) {
    return this.repository.warehouseConfirm(
      id,
      dto.version,
      dto.idempotencyKey,
      toActor(actor),
      cid,
    );
  }
  driverConfirm(id: string, dto: ConfirmLoadingSessionDto, actor: AuthenticatedActor, cid: string) {
    return this.repository.driverConfirm(id, dto.version, dto.idempotencyKey, toActor(actor), cid);
  }
}

function toActor(actor: AuthenticatedActor) {
  return { deviceId: actor.deviceId, employeeId: actor.employee.id, roles: actor.roles };
}
function assertDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)))
    throw new BadRequestException("Некорректная дата");
}
