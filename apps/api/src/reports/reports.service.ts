import { Injectable } from "@nestjs/common";
import type { AuthenticatedActor } from "../identity/identity.types";
import type { CreateReportJobDto } from "./report.dto";
import { ReportsRepository } from "./reports.repository";

@Injectable()
export class ReportsService {
  constructor(private readonly repository: ReportsRepository) {}

  control(date: string, actor: AuthenticatedActor) {
    return this.repository.control(date, toActor(actor));
  }
  workspace(actor: AuthenticatedActor) {
    return this.repository.workspace(toActor(actor));
  }
  productionOutbound(
    dateFrom: string,
    dateTo: string,
    territoryId: string | undefined,
    actor: AuthenticatedActor,
  ) {
    return this.repository.productionOutbound(dateFrom, dateTo, territoryId, toActor(actor));
  }
  createJob(dto: CreateReportJobDto, actor: AuthenticatedActor, correlationId: string) {
    return this.repository.createJob({ actor: toActor(actor), correlationId, ...dto });
  }
  download(id: string, actor: AuthenticatedActor, correlationId: string) {
    return this.repository.download(id, toActor(actor), correlationId);
  }
}

function toActor(actor: AuthenticatedActor) {
  return {
    deviceId: actor.deviceId,
    employeeId: actor.employee.id,
    employeeName: actor.employee.fullName,
    roles: actor.roles,
  };
}
