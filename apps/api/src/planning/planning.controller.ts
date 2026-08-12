import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiTags } from "@nestjs/swagger";

import { CsrfGuard, RequireRoles, RolesGuard, SessionAuthGuard } from "../identity/identity.guards";
import type { AuthenticatedRequest } from "../identity/identity.types";
import {
  CreateCalendarLinkDto,
  CreateNormRequestDto,
  DecideNormRequestDto,
  OverrideProductionPlanDto,
  RunProductionPlanDto,
  SaveTerritoryDailyNormDto,
  SetTerritoryProductionStatusDto,
} from "./planning.dto";
import { PlanningService } from "./planning.service";

@ApiTags("Планирование")
@Controller("planning")
@UseGuards(SessionAuthGuard, CsrfGuard, RolesGuard)
export class PlanningController {
  constructor(private readonly planning: PlanningService) {}

  @Get("setup")
  @RequireRoles("ADMIN", "MANAGER", "WAREHOUSE_KEEPER", "WORKSHOP_MANAGER", "DRIVER")
  setup() {
    return this.planning.setup();
  }

  @Post("monthly-plan/preview")
  @RequireRoles("ADMIN")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 20 * 1024 * 1024, files: 1 } }))
  previewMonthlyPlan(@UploadedFile() file: Express.Multer.File | undefined) {
    return this.planning.previewMonthlyPlan(file);
  }

  @Post("monthly-plan/apply")
  @RequireRoles("ADMIN")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 20 * 1024 * 1024, files: 1 } }))
  applyMonthlyPlan(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.planning.applyMonthlyPlan(
      file,
      requireActorId(request),
      requireCorrelationId(request),
    );
  }

  @Get("weeks/:territoryId")
  @RequireRoles("ADMIN", "MANAGER", "WAREHOUSE_KEEPER", "DRIVER")
  week(
    @Param("territoryId", ParseUUIDPipe) territoryId: string,
    @Query("start") weekStart: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.planning.week(
      territoryId,
      weekStart,
      requireActorId(request),
      request.actor?.roles.map((role) => role.roleCode) ?? [],
    );
  }

  @Get("requests")
  @RequireRoles("ADMIN", "MANAGER")
  requests() {
    return this.planning.requests();
  }

  @Get("territory-norms/:territoryId")
  @RequireRoles("ADMIN", "MANAGER", "WAREHOUSE_KEEPER", "WORKSHOP_MANAGER")
  territoryDailyNorm(
    @Param("territoryId", ParseUUIDPipe) territoryId: string,
    @Query("date") dispatchDate: string,
  ) {
    return this.planning.territoryDailyNorm(territoryId, dispatchDate);
  }

  @Patch("territory-norms/:territoryId")
  @RequireRoles("ADMIN")
  saveTerritoryDailyNorm(
    @Param("territoryId", ParseUUIDPipe) territoryId: string,
    @Body() dto: SaveTerritoryDailyNormDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.planning.saveTerritoryDailyNorm(
      territoryId,
      dto,
      requireActorId(request),
      requireCorrelationId(request),
    );
  }

  @Get("territory-production-status")
  @RequireRoles("ADMIN", "MANAGER", "WAREHOUSE_KEEPER", "WORKSHOP_MANAGER")
  territoryProductionStatuses(@Query("date") effectiveDate: string) {
    return this.planning.territoryProductionStatuses(effectiveDate);
  }

  @Post("territory-production-status/:territoryId")
  @RequireRoles("ADMIN")
  setTerritoryProductionStatus(
    @Param("territoryId", ParseUUIDPipe) territoryId: string,
    @Body() dto: SetTerritoryProductionStatusDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.planning.setTerritoryProductionStatus(
      territoryId,
      dto,
      requireActorId(request),
      requireCorrelationId(request),
    );
  }

  @Post("requests")
  @RequireRoles("DRIVER")
  createRequest(@Body() dto: CreateNormRequestDto, @Req() request: AuthenticatedRequest) {
    return this.planning.createRequest(dto, requireActorId(request), requireCorrelationId(request));
  }

  @Post("requests/:requestId/decision")
  @RequireRoles("ADMIN")
  decideRequest(
    @Param("requestId", ParseUUIDPipe) requestId: string,
    @Body() dto: DecideNormRequestDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.planning.decideRequest(
      requestId,
      dto,
      requireActorId(request),
      requireCorrelationId(request),
    );
  }

  @Post("calendar-links")
  @RequireRoles("ADMIN")
  createCalendarLink(@Body() dto: CreateCalendarLinkDto, @Req() request: AuthenticatedRequest) {
    return this.planning.createCalendarLink(
      dto,
      requireActorId(request),
      requireCorrelationId(request),
    );
  }

  @Get("plans/:productionDate")
  @RequireRoles("ADMIN", "MANAGER", "WAREHOUSE_KEEPER", "WORKSHOP_MANAGER")
  productionPlan(@Param("productionDate") productionDate: string) {
    return this.planning.productionPlan(productionDate);
  }

  @Post("plans/:productionDate/run")
  @RequireRoles("ADMIN")
  runProductionPlan(
    @Param("productionDate") productionDate: string,
    @Body() dto: RunProductionPlanDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.planning.runProductionPlan(
      productionDate,
      dto,
      requireActorId(request),
      requireCorrelationId(request),
    );
  }

  @Post("plans/:productionDate/override")
  @RequireRoles("ADMIN")
  overrideProductionPlan(
    @Param("productionDate") productionDate: string,
    @Body() dto: OverrideProductionPlanDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.planning.overrideProductionPlan(
      productionDate,
      dto,
      requireActorId(request),
      requireCorrelationId(request),
    );
  }
}

function requireActorId(request: AuthenticatedRequest): string {
  if (request.actor === undefined) throw new Error("Authenticated actor is missing");
  return request.actor.employee.id;
}

function requireCorrelationId(request: AuthenticatedRequest): string {
  if (request.correlationId === undefined) throw new Error("Correlation ID is missing");
  return request.correlationId;
}
