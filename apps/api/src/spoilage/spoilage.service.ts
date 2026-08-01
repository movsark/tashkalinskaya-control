import { Injectable } from "@nestjs/common";
import type { AuthenticatedActor } from "../identity/identity.types";
import type {
  CheckExternalDocumentDto,
  CreateWriteoffRequestDto,
  DecideWriteoffRequestDto,
} from "./spoilage.dto";
import { SpoilageRepository } from "./spoilage.repository";

@Injectable()
export class SpoilageService {
  constructor(private readonly repository: SpoilageRepository) {}
  workspace(actor: AuthenticatedActor) {
    return this.repository.workspace(toActor(actor));
  }
  create(dto: CreateWriteoffRequestDto, actor: AuthenticatedActor, correlationId: string) {
    return this.repository.create({
      actor: toActor(actor),
      businessDate: dto.businessDate,
      comment: dto.comment.trim(),
      correlationId,
      externalDocumentNumber: dto.externalDocumentNumber?.trim() ?? null,
      idempotencyKey: dto.idempotencyKey,
      photoUploadId: dto.photoUploadId ?? null,
      physicalSourceKind: dto.physicalSourceKind ?? null,
      productId: dto.productId,
      quantity: dto.quantity,
      reasonId: dto.reasonId,
      sourceDriverId: dto.sourceDriverId ?? null,
      sourceKind: dto.sourceKind,
      sourceLabel: dto.sourceLabel?.trim() ?? null,
    });
  }
  decide(
    id: string,
    dto: DecideWriteoffRequestDto,
    actor: AuthenticatedActor,
    correlationId: string,
  ) {
    return this.repository.decide({
      actor: toActor(actor),
      comment: dto.comment.trim(),
      correlationId,
      decision: dto.decision,
      idempotencyKey: dto.idempotencyKey,
      requestId: id,
      version: dto.version,
    });
  }
  check(
    id: string,
    dto: CheckExternalDocumentDto,
    actor: AuthenticatedActor,
    correlationId: string,
  ) {
    return this.repository.check({
      actor: toActor(actor),
      comment: dto.comment?.trim() ?? null,
      correlationId,
      externalDocumentNumber: dto.externalDocumentNumber.trim(),
      idempotencyKey: dto.idempotencyKey,
      requestId: id,
      result: dto.result,
    });
  }
}

function toActor(actor: AuthenticatedActor) {
  return { deviceId: actor.deviceId, employeeId: actor.employee.id, roles: actor.roles };
}
