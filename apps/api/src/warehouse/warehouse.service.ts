import { Injectable } from "@nestjs/common";
import type { AuthenticatedActor } from "../identity/identity.types";
import type {
  CreateWarehouseCorrectionDto,
  ExplainWarehouseDiscrepancyDto,
  ReceiveWarehouseBatchDto,
  ResolveWarehouseDiscrepancyDto,
} from "./warehouse.dto";
import { WarehouseRepository } from "./warehouse.repository";

@Injectable()
export class WarehouseService {
  constructor(private readonly repository: WarehouseRepository) {}
  workspace(actor: AuthenticatedActor) {
    return this.repository.workspace(toActor(actor));
  }
  claim(id: string, version: number, actor: AuthenticatedActor, cid: string) {
    return this.repository.claim(id, version, toActor(actor), cid);
  }
  release(id: string, reason: string, actor: AuthenticatedActor, cid: string) {
    return this.repository.release(id, reason.trim(), toActor(actor), cid);
  }
  receive(id: string, dto: ReceiveWarehouseBatchDto, actor: AuthenticatedActor, cid: string) {
    return this.repository.receive({
      acceptedQuantity: dto.acceptedQuantity,
      actor: toActor(actor),
      batchId: id,
      comment: dto.comment?.trim() ?? null,
      correlationId: cid,
      idempotencyKey: dto.idempotencyKey,
      reasonId: dto.reasonId ?? null,
      version: dto.version,
    });
  }
  explain(id: string, dto: ExplainWarehouseDiscrepancyDto, actor: AuthenticatedActor, cid: string) {
    return this.repository.explain(id, dto.explanation.trim(), dto.version, toActor(actor), cid);
  }
  resolve(id: string, dto: ResolveWarehouseDiscrepancyDto, actor: AuthenticatedActor, cid: string) {
    return this.repository.resolve(
      id,
      dto.resolutionCode,
      dto.comment.trim(),
      dto.version,
      toActor(actor),
      cid,
    );
  }
  correct(dto: CreateWarehouseCorrectionDto, actor: AuthenticatedActor, cid: string) {
    return this.repository.correct({
      actor: toActor(actor),
      bucket: dto.bucket,
      comment: dto.comment.trim(),
      correlationId: cid,
      direction: dto.direction,
      idempotencyKey: dto.idempotencyKey,
      productId: dto.productId,
      quantity: dto.quantity,
      reasonId: dto.reasonId,
      relatedDocumentId: dto.relatedDocumentId ?? null,
    });
  }
}
function toActor(actor: AuthenticatedActor) {
  return { deviceId: actor.deviceId, employeeId: actor.employee.id, roles: actor.roles };
}
