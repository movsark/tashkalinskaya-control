import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";

import { CsrfGuard, RequireRoles, RolesGuard, SessionAuthGuard } from "../identity/identity.guards";
import type { AuthenticatedRequest } from "../identity/identity.types";
import {
  ApplyInventoryToPlanDto,
  CountInventoryLineDto,
  InventoryDateDto,
  OpenInventoryDto,
  ResolveInventoryDiscrepancyDto,
  SubmitInventoryDto,
} from "./inventory.dto";
import { InventoryService } from "./inventory.service";

@ApiTags("Инвентаризация")
@Controller("inventory")
@UseGuards(SessionAuthGuard, CsrfGuard, RolesGuard)
export class InventoryController {
  constructor(private readonly service: InventoryService) {}

  @Get("workspace")
  @RequireRoles("ADMIN", "MANAGER", "WAREHOUSE_KEEPER")
  workspace(@Query() query: InventoryDateDto, @Req() request: AuthenticatedRequest) {
    return this.service.workspace(query.date, actor(request));
  }

  @Post("sessions")
  @RequireRoles("ADMIN", "WAREHOUSE_KEEPER")
  open(@Body() dto: OpenInventoryDto, @Req() request: AuthenticatedRequest) {
    return this.service.open(dto, actor(request), correlationId(request));
  }

  @Put("lines/:id")
  @RequireRoles("ADMIN", "WAREHOUSE_KEEPER")
  count(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: CountInventoryLineDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.service.count(id, dto, actor(request), correlationId(request));
  }

  @Post("sessions/:id/submit")
  @RequireRoles("ADMIN", "WAREHOUSE_KEEPER")
  submit(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: SubmitInventoryDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.service.submit(id, dto, actor(request), correlationId(request));
  }

  @Post("sessions/:id/apply-to-plan")
  @RequireRoles("ADMIN")
  applyToPlan(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: ApplyInventoryToPlanDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.service.applyToPlan(id, dto, actor(request), correlationId(request));
  }

  @Post("discrepancies/:id/resolve")
  @RequireRoles("ADMIN")
  resolve(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: ResolveInventoryDiscrepancyDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.service.resolve(id, dto, actor(request), correlationId(request));
  }
}

function actor(request: AuthenticatedRequest) {
  if (!request.actor) throw new Error("Authenticated actor missing");
  return request.actor;
}

function correlationId(request: AuthenticatedRequest) {
  if (!request.correlationId) throw new Error("Correlation ID missing");
  return request.correlationId;
}
