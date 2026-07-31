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
import { CreateCalendarLinkDto, CreateNormRequestDto, DecideNormRequestDto } from "./planning.dto";
import { PlanningService } from "./planning.service";

@ApiTags("Планирование")
@Controller("planning")
@UseGuards(SessionAuthGuard, CsrfGuard, RolesGuard)
export class PlanningController {
  constructor(private readonly planning: PlanningService) {}

  @Get("setup")
  @RequireRoles("ADMIN", "MANAGER", "WAREHOUSE_KEEPER", "DRIVER")
  setup() {
    return this.planning.setup();
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
}

function requireActorId(request: AuthenticatedRequest): string {
  if (request.actor === undefined) throw new Error("Authenticated actor is missing");
  return request.actor.employee.id;
}

function requireCorrelationId(request: AuthenticatedRequest): string {
  if (request.correlationId === undefined) throw new Error("Correlation ID is missing");
  return request.correlationId;
}
