import { Injectable } from "@nestjs/common";

import type { AuthenticatedActor } from "../identity/identity.types";
import type {
  CountInventoryLineDto,
  OpenInventoryDto,
  ResolveInventoryDiscrepancyDto,
  SubmitInventoryDto,
} from "./inventory.dto";
import { InventoryRepository } from "./inventory.repository";

@Injectable()
export class InventoryService {
  constructor(private readonly repository: InventoryRepository) {}

  workspace(date: string, actor: AuthenticatedActor) {
    return this.repository.workspace(date, toActor(actor));
  }

  open(dto: OpenInventoryDto, actor: AuthenticatedActor, correlationId: string) {
    return this.repository.open({
      actor: toActor(actor),
      businessDate: dto.businessDate,
      correlationId,
      idempotencyKey: dto.idempotencyKey,
      reason: dto.reason?.trim() ?? null,
    });
  }

  count(id: string, dto: CountInventoryLineDto, actor: AuthenticatedActor, correlationId: string) {
    return this.repository.count({
      actor: toActor(actor),
      actualQuantity: dto.actualQuantity,
      correlationId,
      idempotencyKey: dto.idempotencyKey,
      lineId: id,
      version: dto.version,
    });
  }

  submit(id: string, dto: SubmitInventoryDto, actor: AuthenticatedActor, correlationId: string) {
    return this.repository.submit({
      actor: toActor(actor),
      correlationId,
      idempotencyKey: dto.idempotencyKey,
      sessionId: id,
      version: dto.version,
    });
  }

  resolve(
    id: string,
    dto: ResolveInventoryDiscrepancyDto,
    actor: AuthenticatedActor,
    correlationId: string,
  ) {
    return this.repository.resolve({
      actor: toActor(actor),
      comment: dto.comment.trim(),
      correlationId,
      discrepancyId: id,
      idempotencyKey: dto.idempotencyKey,
      resolutionCode: dto.resolutionCode,
      version: dto.version,
    });
  }
}

function toActor(actor: AuthenticatedActor) {
  return { deviceId: actor.deviceId, employeeId: actor.employee.id, roles: actor.roles };
}
