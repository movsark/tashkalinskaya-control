import { Injectable } from "@nestjs/common";
import type { AuthenticatedActor } from "../identity/identity.types";
import type {
  AllocateGoodReturnDto,
  CancelGoodReturnAllocationDto,
  ReceiveGoodReturnDto,
  ReviseGoodReturnAllocationDto,
} from "./good-returns.dto";
import { GoodReturnsRepository } from "./good-returns.repository";

@Injectable()
export class GoodReturnsService {
  constructor(private readonly repository: GoodReturnsRepository) {}
  workspace(dispatchDate: string, actor: AuthenticatedActor) {
    return this.repository.workspace(dispatchDate, toActor(actor));
  }
  receive(dto: ReceiveGoodReturnDto, actor: AuthenticatedActor, correlationId: string) {
    return this.repository.receive({
      ...dto,
      comment: dto.comment?.trim() ?? null,
      actor: toActor(actor),
      correlationId,
    });
  }
  allocate(dto: AllocateGoodReturnDto, actor: AuthenticatedActor, correlationId: string) {
    return this.repository.allocate({
      ...dto,
      reason: dto.reason?.trim() ?? null,
      actor: toActor(actor),
      correlationId,
    });
  }
  revise(
    id: string,
    dto: ReviseGoodReturnAllocationDto,
    actor: AuthenticatedActor,
    correlationId: string,
  ) {
    return this.repository.revise({
      ...dto,
      allocationId: id,
      reason: dto.reason.trim(),
      actor: toActor(actor),
      correlationId,
    });
  }
  cancel(
    id: string,
    dto: CancelGoodReturnAllocationDto,
    actor: AuthenticatedActor,
    correlationId: string,
  ) {
    return this.repository.cancel({
      ...dto,
      allocationId: id,
      quantity: 0,
      reason: dto.reason.trim(),
      actor: toActor(actor),
      correlationId,
    });
  }
}

function toActor(actor: AuthenticatedActor) {
  return { deviceId: actor.deviceId, employeeId: actor.employee.id, roles: actor.roles };
}
