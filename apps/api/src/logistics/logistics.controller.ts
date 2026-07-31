import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";

import { CsrfGuard, RequireRoles, RolesGuard, SessionAuthGuard } from "../identity/identity.guards";
import type { AuthenticatedRequest } from "../identity/identity.types";
import {
  CreateDefaultAssignmentDto,
  CreateExtraRunDto,
  CreateLoadingGroupDto,
  CreateVehicleDto,
  GenerateDayDto,
  MarkRunReadyDto,
  PublishDayDto,
  UpdateRunAssignmentDto,
  UpdateTerritoryDto,
  UpdateVehicleDto,
  UpsertDriverProfileDto,
} from "./logistics.dto";
import { LogisticsService } from "./logistics.service";

@ApiTags("Логистика")
@Controller("logistics")
@UseGuards(SessionAuthGuard, CsrfGuard, RolesGuard)
export class LogisticsController {
  constructor(private readonly logistics: LogisticsService) {}

  @Get("setup")
  @RequireRoles("ADMIN", "MANAGER", "WAREHOUSE_KEEPER")
  setup() {
    return this.logistics.setup();
  }

  @Patch("territories/:territoryId")
  @RequireRoles("ADMIN")
  updateTerritory(
    @Param("territoryId", ParseUUIDPipe) territoryId: string,
    @Body() dto: UpdateTerritoryDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.logistics.updateTerritory(
      territoryId,
      dto,
      requireActorId(request),
      requireCorrelationId(request),
    );
  }

  @Post("vehicles")
  @RequireRoles("ADMIN")
  createVehicle(@Body() dto: CreateVehicleDto, @Req() request: AuthenticatedRequest) {
    return this.logistics.createVehicle(
      dto,
      requireActorId(request),
      requireCorrelationId(request),
    );
  }

  @Patch("vehicles/:vehicleId")
  @RequireRoles("ADMIN")
  updateVehicle(
    @Param("vehicleId", ParseUUIDPipe) vehicleId: string,
    @Body() dto: UpdateVehicleDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.logistics.updateVehicle(
      vehicleId,
      dto,
      requireActorId(request),
      requireCorrelationId(request),
    );
  }

  @Put("drivers/:employeeId")
  @RequireRoles("ADMIN")
  upsertDriver(
    @Param("employeeId", ParseUUIDPipe) employeeId: string,
    @Body() dto: UpsertDriverProfileDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.logistics.upsertDriver(
      employeeId,
      dto,
      requireActorId(request),
      requireCorrelationId(request),
    );
  }

  @Post("default-assignments")
  @RequireRoles("ADMIN")
  createDefaultAssignment(
    @Body() dto: CreateDefaultAssignmentDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.logistics.createDefaultAssignment(
      dto,
      requireActorId(request),
      requireCorrelationId(request),
    );
  }

  @Get("days/:dispatchDate")
  @RequireRoles("ADMIN", "MANAGER", "WAREHOUSE_KEEPER")
  day(@Param("dispatchDate") dispatchDate: string) {
    return this.logistics.day(dispatchDate);
  }

  @Get("me/days/:dispatchDate")
  @RequireRoles("DRIVER")
  driverDay(@Param("dispatchDate") dispatchDate: string, @Req() request: AuthenticatedRequest) {
    return this.logistics.driverDay(dispatchDate, requireActorId(request));
  }

  @Get("warehouse/days/:dispatchDate")
  @RequireRoles("ADMIN", "WAREHOUSE_KEEPER")
  warehouseDay(@Param("dispatchDate") dispatchDate: string) {
    return this.logistics.warehouseDay(dispatchDate);
  }

  @Post("days/:dispatchDate/generate")
  @RequireRoles("ADMIN")
  generateDay(
    @Param("dispatchDate") dispatchDate: string,
    @Body() dto: GenerateDayDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.logistics.generateDay(
      dispatchDate,
      dto,
      requireActorId(request),
      requireCorrelationId(request),
    );
  }

  @Post("groups")
  @RequireRoles("ADMIN")
  createGroup(@Body() dto: CreateLoadingGroupDto, @Req() request: AuthenticatedRequest) {
    return this.logistics.createGroup(dto, requireActorId(request), requireCorrelationId(request));
  }

  @Patch("runs/:runId/assignment")
  @RequireRoles("ADMIN")
  updateRun(
    @Param("runId", ParseUUIDPipe) runId: string,
    @Body() dto: UpdateRunAssignmentDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.logistics.updateRun(
      runId,
      dto,
      requireActorId(request),
      requireCorrelationId(request),
    );
  }

  @Post("runs/:runId/ready")
  @RequireRoles("ADMIN", "WAREHOUSE_KEEPER")
  markRunReady(
    @Param("runId", ParseUUIDPipe) runId: string,
    @Body() dto: MarkRunReadyDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.logistics.markRunReady(
      runId,
      dto,
      requireActorId(request),
      request.actor?.roles.some((role) => role.roleCode === "WAREHOUSE_KEEPER")
        ? "WAREHOUSE_KEEPER"
        : "ADMIN",
      requireCorrelationId(request),
    );
  }

  @Post("runs/extra")
  @RequireRoles("ADMIN")
  createExtraRun(@Body() dto: CreateExtraRunDto, @Req() request: AuthenticatedRequest) {
    return this.logistics.createExtraRun(
      dto,
      requireActorId(request),
      requireCorrelationId(request),
    );
  }

  @Post("days/:dispatchDate/publish")
  @RequireRoles("ADMIN")
  publishDay(
    @Param("dispatchDate") dispatchDate: string,
    @Body() dto: PublishDayDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.logistics.publishDay(
      dispatchDate,
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
