import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { CsrfGuard, RequireRoles, RolesGuard, SessionAuthGuard } from "../identity/identity.guards";
import type { AuthenticatedRequest } from "../identity/identity.types";
import {
  ConfirmLoadingSessionDto,
  CreateLoadingLineDto,
  OpenLoadingGroupDto,
  ReassignLoadingLineDto,
  RespondLoadingLineDto,
  ReviseLoadingLineDto,
} from "./loading.dto";
import { LoadingService } from "./loading.service";

@ApiTags("Погрузка")
@Controller("loading")
@UseGuards(SessionAuthGuard, CsrfGuard, RolesGuard)
export class LoadingController {
  constructor(private readonly service: LoadingService) {}

  @Get("warehouse/days/:date")
  @RequireRoles("ADMIN", "MANAGER", "WAREHOUSE_KEEPER")
  warehouseDay(@Param("date") date: string, @Req() request: AuthenticatedRequest) {
    return this.service.warehouseDay(date, actor(request));
  }
  @Get("driver/days/:date")
  @RequireRoles("DRIVER")
  driverDay(@Param("date") date: string, @Req() request: AuthenticatedRequest) {
    return this.service.driverDay(date, actor(request));
  }
  @Post("groups/:id/open")
  @RequireRoles("ADMIN", "WAREHOUSE_KEEPER")
  openGroup(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: OpenLoadingGroupDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.service.openGroup(id, dto, actor(request), correlationId(request));
  }
  @Post("sessions/:id/lines")
  @RequireRoles("ADMIN", "WAREHOUSE_KEEPER")
  createLine(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: CreateLoadingLineDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.service.createLine(id, dto, actor(request), correlationId(request));
  }
  @Put("lines/:id")
  @RequireRoles("ADMIN", "WAREHOUSE_KEEPER")
  reviseLine(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: ReviseLoadingLineDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.service.reviseLine(id, dto, actor(request), correlationId(request));
  }
  @Post("lines/:id/reassign")
  @RequireRoles("ADMIN", "WAREHOUSE_KEEPER")
  reassignLine(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: ReassignLoadingLineDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.service.reassignLine(id, dto, actor(request), correlationId(request));
  }
  @Post("lines/:id/respond")
  @RequireRoles("DRIVER")
  respondLine(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: RespondLoadingLineDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.service.respondLine(id, dto, actor(request), correlationId(request));
  }
  @Post("sessions/:id/warehouse-confirm")
  @RequireRoles("ADMIN", "WAREHOUSE_KEEPER")
  warehouseConfirm(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: ConfirmLoadingSessionDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.service.warehouseConfirm(id, dto, actor(request), correlationId(request));
  }
  @Post("sessions/:id/driver-confirm")
  @RequireRoles("DRIVER")
  driverConfirm(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: ConfirmLoadingSessionDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.service.driverConfirm(id, dto, actor(request), correlationId(request));
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
