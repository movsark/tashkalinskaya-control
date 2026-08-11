import { BadRequestException, Injectable } from "@nestjs/common";

import type {
  AssignProductionTaskDto,
  CloseProductionTaskDto,
  CreateProductionTransferDto,
  DecideOverproductionDto,
  DecideProductionDefectDto,
  DecideProductionTransferDto,
  ResubmitProductionDefectDto,
  StartProductionTaskDto,
  SubmitProductionBatchDto,
  SubmitProductionDefectDto,
  WithdrawProductionBatchDto,
} from "./production.dto";
import { type ProductionActor, ProductionRepository } from "./production.repository";

@Injectable()
export class ProductionService {
  constructor(private readonly repository: ProductionRepository) {}

  workspace(date: string, workshopId: string | undefined, actor: ProductionActor) {
    assertDate(date);
    return this.repository.workspace(date, workshopId ?? null, actor);
  }

  warehouseQueue(actor: ProductionActor) {
    return this.repository.warehouseQueue(actor);
  }

  generate(date: string, actor: ProductionActor, correlationId: string) {
    assertDate(date);
    return this.repository.generateTasks({ actor, correlationId, productionDate: date });
  }

  claim(date: string, productId: string, actor: ProductionActor, correlationId: string) {
    assertDate(date);
    return this.repository.claimNormDemand({
      actor,
      correlationId,
      productId,
      productionDate: date,
    });
  }

  assign(
    taskId: string,
    dto: AssignProductionTaskDto,
    actor: ProductionActor,
    correlationId: string,
  ) {
    return this.repository.assign({
      actor,
      correlationId,
      participants: dto.participants,
      reason: clean(dto.reason),
      taskId,
      version: dto.version,
    });
  }

  start(
    taskId: string,
    dto: StartProductionTaskDto,
    actor: ProductionActor,
    correlationId: string,
  ) {
    return this.repository.start({ actor, correlationId, taskId, version: dto.version });
  }

  submitBatch(
    taskId: string,
    dto: SubmitProductionBatchDto,
    actor: ProductionActor,
    correlationId: string,
  ) {
    return this.repository.submitBatch({
      actor,
      comment: clean(dto.comment),
      correlationId,
      idempotencyKey: dto.idempotencyKey,
      producedAt: assertOperationalTimestamp(dto.producedAt),
      quantity: dto.quantity,
      reasonId: dto.reasonId ?? null,
      replacementForBatchId: dto.replacementForBatchId ?? null,
      taskId,
      taskVersion: dto.taskVersion,
    });
  }

  withdrawBatch(
    batchId: string,
    dto: WithdrawProductionBatchDto,
    actor: ProductionActor,
    correlationId: string,
  ) {
    return this.repository.withdrawBatch({
      actor,
      batchId,
      correlationId,
      reason: dto.reason.trim(),
      version: dto.version,
    });
  }

  decideOverproduction(
    batchId: string,
    dto: DecideOverproductionDto,
    actor: ProductionActor,
    correlationId: string,
  ) {
    return this.repository.decideOverproduction({
      actor,
      batchId,
      comment: dto.comment.trim(),
      correlationId,
      decision: dto.decision,
      version: dto.version,
    });
  }

  closeTask(
    taskId: string,
    dto: CloseProductionTaskDto,
    actor: ProductionActor,
    correlationId: string,
  ) {
    return this.repository.closeTask({
      actor,
      comment: clean(dto.comment),
      correlationId,
      reasonId: dto.reasonId ?? null,
      taskId,
      version: dto.version,
    });
  }

  submitDefect(
    taskId: string,
    dto: SubmitProductionDefectDto,
    actor: ProductionActor,
    correlationId: string,
  ) {
    return this.repository.submitDefect({
      actor,
      allegedEmployeeId: dto.allegedEmployeeId ?? null,
      comment: dto.comment.trim(),
      correlationId,
      idempotencyKey: dto.idempotencyKey,
      occurredAt: assertOperationalTimestamp(dto.occurredAt),
      quantity: dto.quantity,
      reasonId: dto.reasonId,
      sourceBatchId: dto.sourceBatchId ?? null,
      taskId,
    });
  }

  decideDefect(
    defectId: string,
    dto: DecideProductionDefectDto,
    actor: ProductionActor,
    correlationId: string,
  ) {
    return this.repository.decideDefect({
      actor,
      comment: dto.comment.trim(),
      correlationId,
      decision: dto.decision,
      defectId,
      version: dto.version,
    });
  }

  resubmitDefect(
    defectId: string,
    dto: ResubmitProductionDefectDto,
    actor: ProductionActor,
    correlationId: string,
  ) {
    return this.repository.resubmitDefect({
      actor,
      comment: dto.comment.trim(),
      correlationId,
      defectId,
      version: dto.version,
    });
  }

  createTransfer(dto: CreateProductionTransferDto, actor: ProductionActor, correlationId: string) {
    assertDate(dto.validFrom);
    assertDate(dto.validUntil);
    if (dto.validUntil < dto.validFrom)
      throw new BadRequestException("Конец периода раньше начала");
    if (dto.fromWorkshopId === dto.toWorkshopId)
      throw new BadRequestException("Укажите другой принимающий цех");
    return this.repository.createTransfer({
      actor,
      correlationId,
      fromWorkshopId: dto.fromWorkshopId,
      productId: dto.productId,
      reason: dto.reason.trim(),
      toWorkshopId: dto.toWorkshopId,
      validFrom: dto.validFrom,
      validUntil: dto.validUntil,
    });
  }

  decideTransfer(
    transferId: string,
    dto: DecideProductionTransferDto,
    actor: ProductionActor,
    correlationId: string,
  ) {
    return this.repository.decideTransfer({
      actor,
      comment: dto.comment.trim(),
      correlationId,
      decision: dto.decision,
      transferId,
      version: dto.version,
    });
  }
}

function clean(value: string | undefined): string | null {
  const result = value?.trim() ?? "";
  return result === "" ? null : result;
}

function assertDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new BadRequestException("Неверный формат даты");
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new BadRequestException("Недопустимая дата");
  }
}

function assertOperationalTimestamp(value: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new BadRequestException("Неверное время операции");
  if (parsed.getTime() > Date.now() + 5 * 60_000) {
    throw new BadRequestException("Время операции не может быть в будущем");
  }
  if (parsed.getTime() < Date.now() - 72 * 60 * 60_000) {
    throw new BadRequestException("Время выпуска слишком далеко от текущей смены");
  }
  return parsed;
}
