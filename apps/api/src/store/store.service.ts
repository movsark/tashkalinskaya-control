import { BadRequestException, Injectable } from "@nestjs/common";

import type {
  CreateStoreLateRequestDto,
  DecideStoreLateRequestDto,
  SaveStoreDraftDto,
  StoreOrderLineDto,
  SubmitStoreOrderDto,
} from "./store.dto";
import { StoreRepository } from "./store.repository";

@Injectable()
export class StoreService {
  constructor(private readonly repository: StoreRepository) {}

  workspace(actorEmployeeId: string, privileged: boolean) {
    return this.repository.workspace(actorEmployeeId, privileged);
  }

  workspaceForDate(deliveryDate: string, actorEmployeeId: string, privileged: boolean) {
    assertDate(deliveryDate);
    return this.repository.workspaceForDate(deliveryDate, actorEmployeeId, privileged);
  }

  saveDraft(
    deliveryDate: string,
    dto: SaveStoreDraftDto,
    actorEmployeeId: string,
    activeRole: "ADMIN" | "STORE_SELLER",
    correlationId: string,
  ) {
    assertDate(deliveryDate);
    assertUniqueProducts(dto.lines);
    return this.repository.saveDraft({
      activeRole,
      actorEmployeeId,
      correlationId,
      deliveryDate,
      draftVersion: dto.draftVersion,
      lines: cleanLines(dto.lines),
      privileged: activeRole === "ADMIN",
    });
  }

  submit(
    deliveryDate: string,
    dto: SubmitStoreOrderDto,
    actorEmployeeId: string,
    activeRole: "ADMIN" | "STORE_SELLER",
    correlationId: string,
  ) {
    assertDate(deliveryDate);
    assertSubmission(dto.submittedZero, dto.lines);
    return this.repository.submit({
      activeRole,
      actorEmployeeId,
      baseVersionNo: dto.baseVersionNo,
      correlationId,
      deliveryDate,
      idempotencyKey: dto.idempotencyKey,
      lines: cleanLines(dto.lines),
      privileged: activeRole === "ADMIN",
      submittedZero: dto.submittedZero,
    });
  }

  createLateRequest(
    deliveryDate: string,
    dto: CreateStoreLateRequestDto,
    actorEmployeeId: string,
    activeRole: "ADMIN" | "STORE_SELLER",
    correlationId: string,
  ) {
    assertDate(deliveryDate);
    assertSubmission(dto.submittedZero, dto.lines);
    return this.repository.createLateRequest({
      activeRole,
      actorEmployeeId,
      correlationId,
      deliveryDate,
      idempotencyKey: dto.idempotencyKey,
      lines: cleanLines(dto.lines),
      privileged: activeRole === "ADMIN",
      reason: dto.reason.trim(),
      submittedZero: dto.submittedZero,
    });
  }

  lateRequests() {
    return this.repository.listLateRequests();
  }

  decideLateRequest(
    requestId: string,
    dto: DecideStoreLateRequestDto,
    actorEmployeeId: string,
    correlationId: string,
  ) {
    return this.repository.decideLateRequest({
      activeRole: "ADMIN",
      actorEmployeeId,
      comment: dto.comment.trim(),
      correlationId,
      decision: dto.decision,
      idempotencyKey: dto.idempotencyKey,
      requestId,
      version: dto.version,
    });
  }
}

function assertSubmission(submittedZero: boolean, lines: readonly StoreOrderLineDto[]): void {
  assertUniqueProducts(lines);
  if (submittedZero && lines.length > 0) {
    throw new BadRequestException("Нулевой заказ не может содержать строки");
  }
  if (!submittedZero && lines.length === 0) {
    throw new BadRequestException("Добавьте хотя бы один товар или подтвердите нулевой заказ");
  }
}

function assertUniqueProducts(lines: readonly StoreOrderLineDto[]): void {
  if (new Set(lines.map((line) => line.productId)).size !== lines.length) {
    throw new BadRequestException("Один товар указан несколько раз");
  }
}

function cleanLines(lines: readonly StoreOrderLineDto[]) {
  return lines.map((line) => ({
    comment: cleanOptional(line.comment),
    productId: line.productId,
    quantity: line.quantity,
  }));
}

function cleanOptional(value: string | undefined): string | null {
  const cleaned = value?.trim() ?? "";
  return cleaned === "" ? null : cleaned;
}

function assertDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new BadRequestException("Неверный формат даты");
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new BadRequestException("Недопустимая дата");
  }
}
