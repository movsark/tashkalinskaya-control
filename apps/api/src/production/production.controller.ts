import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";

import { CsrfGuard, RequireRoles, RolesGuard, SessionAuthGuard } from "../identity/identity.guards";
import type { AuthenticatedRequest } from "../identity/identity.types";
import {
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
import { actorFromSession } from "./production.repository";
import { ProductionService } from "./production.service";

@ApiTags("Производство")
@Controller("production")
@UseGuards(SessionAuthGuard, CsrfGuard, RolesGuard)
export class ProductionController {
  constructor(private readonly production: ProductionService) {}

  @Get("workspace")
  @RequireRoles("ADMIN", "MANAGER", "WAREHOUSE_KEEPER", "WORKSHOP_MANAGER", "CONFECTIONER")
  workspace(
    @Query("date") date: string,
    @Query("workshopId") workshopId: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.production.workspace(date, workshopId, requireActor(request));
  }

  @Get("warehouse-queue")
  @RequireRoles("ADMIN", "MANAGER", "WAREHOUSE_KEEPER")
  warehouseQueue(@Req() request: AuthenticatedRequest) {
    return this.production.warehouseQueue(requireActor(request));
  }

  @Post("days/:productionDate/generate")
  @RequireRoles("ADMIN")
  generate(@Param("productionDate") productionDate: string, @Req() request: AuthenticatedRequest) {
    return this.production.generate(
      productionDate,
      requireActor(request),
      requireCorrelationId(request),
    );
  }

  @Post("days/:productionDate/products/:productId/claim")
  @RequireRoles("CONFECTIONER")
  claim(
    @Param("productionDate") productionDate: string,
    @Param("productId", ParseUUIDPipe) productId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.production.claim(
      productionDate,
      productId,
      requireActor(request),
      requireCorrelationId(request),
    );
  }

  @Post("tasks/:taskId/assign")
  @RequireRoles("ADMIN", "WORKSHOP_MANAGER")
  assign(
    @Param("taskId", ParseUUIDPipe) taskId: string,
    @Body() dto: AssignProductionTaskDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.production.assign(
      taskId,
      dto,
      requireActor(request),
      requireCorrelationId(request),
    );
  }

  @Post("tasks/:taskId/start")
  @RequireRoles("ADMIN", "WORKSHOP_MANAGER", "CONFECTIONER")
  start(
    @Param("taskId", ParseUUIDPipe) taskId: string,
    @Body() dto: StartProductionTaskDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.production.start(taskId, dto, requireActor(request), requireCorrelationId(request));
  }

  @Post("tasks/:taskId/batches")
  @RequireRoles("ADMIN", "WORKSHOP_MANAGER", "CONFECTIONER")
  submitBatch(
    @Param("taskId", ParseUUIDPipe) taskId: string,
    @Body() dto: SubmitProductionBatchDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.production.submitBatch(
      taskId,
      dto,
      requireActor(request),
      requireCorrelationId(request),
    );
  }

  @Post("batches/:batchId/withdraw")
  @RequireRoles("ADMIN", "WORKSHOP_MANAGER", "CONFECTIONER")
  withdrawBatch(
    @Param("batchId", ParseUUIDPipe) batchId: string,
    @Body() dto: WithdrawProductionBatchDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.production.withdrawBatch(
      batchId,
      dto,
      requireActor(request),
      requireCorrelationId(request),
    );
  }

  @Post("batches/:batchId/overproduction-decision")
  @RequireRoles("ADMIN", "WORKSHOP_MANAGER")
  decideOverproduction(
    @Param("batchId", ParseUUIDPipe) batchId: string,
    @Body() dto: DecideOverproductionDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.production.decideOverproduction(
      batchId,
      dto,
      requireActor(request),
      requireCorrelationId(request),
    );
  }

  @Post("tasks/:taskId/close")
  @RequireRoles("ADMIN", "WORKSHOP_MANAGER")
  closeTask(
    @Param("taskId", ParseUUIDPipe) taskId: string,
    @Body() dto: CloseProductionTaskDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.production.closeTask(
      taskId,
      dto,
      requireActor(request),
      requireCorrelationId(request),
    );
  }

  @Post("tasks/:taskId/defects")
  @RequireRoles("ADMIN", "WORKSHOP_MANAGER", "CONFECTIONER")
  submitDefect(
    @Param("taskId", ParseUUIDPipe) taskId: string,
    @Body() dto: SubmitProductionDefectDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.production.submitDefect(
      taskId,
      dto,
      requireActor(request),
      requireCorrelationId(request),
    );
  }

  @Post("defects/:defectId/decision")
  @RequireRoles("ADMIN", "WORKSHOP_MANAGER")
  decideDefect(
    @Param("defectId", ParseUUIDPipe) defectId: string,
    @Body() dto: DecideProductionDefectDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.production.decideDefect(
      defectId,
      dto,
      requireActor(request),
      requireCorrelationId(request),
    );
  }

  @Post("defects/:defectId/resubmit")
  @RequireRoles("ADMIN", "WORKSHOP_MANAGER", "CONFECTIONER")
  resubmitDefect(
    @Param("defectId", ParseUUIDPipe) defectId: string,
    @Body() dto: ResubmitProductionDefectDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.production.resubmitDefect(
      defectId,
      dto,
      requireActor(request),
      requireCorrelationId(request),
    );
  }

  @Post("transfers")
  @RequireRoles("ADMIN", "WORKSHOP_MANAGER")
  createTransfer(@Body() dto: CreateProductionTransferDto, @Req() request: AuthenticatedRequest) {
    return this.production.createTransfer(
      dto,
      requireActor(request),
      requireCorrelationId(request),
    );
  }

  @Post("transfers/:transferId/decision")
  @RequireRoles("ADMIN")
  decideTransfer(
    @Param("transferId", ParseUUIDPipe) transferId: string,
    @Body() dto: DecideProductionTransferDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.production.decideTransfer(
      transferId,
      dto,
      requireActor(request),
      requireCorrelationId(request),
    );
  }
}

function requireActor(request: AuthenticatedRequest) {
  if (request.actor === undefined) throw new Error("Authenticated actor is missing");
  return actorFromSession(request.actor);
}

function requireCorrelationId(request: AuthenticatedRequest): string {
  if (request.correlationId === undefined) throw new Error("Correlation ID is missing");
  return request.correlationId;
}
