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
  AllocateGoodReturnDto,
  CancelGoodReturnAllocationDto,
  ReceiveGoodReturnDto,
  ReviseGoodReturnAllocationDto,
} from "./good-returns.dto";
import { GoodReturnsService } from "./good-returns.service";

@ApiTags("Годный возврат")
@Controller("returns")
@UseGuards(SessionAuthGuard, CsrfGuard, RolesGuard)
export class GoodReturnsController {
  constructor(private readonly service: GoodReturnsService) {}

  @Get("workspace")
  @RequireRoles("ADMIN", "MANAGER", "WAREHOUSE_KEEPER")
  workspace(@Query("dispatchDate") dispatchDate: string, @Req() request: AuthenticatedRequest) {
    return this.service.workspace(dispatchDate, actor(request));
  }

  @Post("receipts")
  @RequireRoles("ADMIN", "WAREHOUSE_KEEPER")
  receive(@Body() dto: ReceiveGoodReturnDto, @Req() request: AuthenticatedRequest) {
    return this.service.receive(dto, actor(request), correlationId(request));
  }

  @Post("allocations")
  @RequireRoles("ADMIN", "WAREHOUSE_KEEPER")
  allocate(@Body() dto: AllocateGoodReturnDto, @Req() request: AuthenticatedRequest) {
    return this.service.allocate(dto, actor(request), correlationId(request));
  }

  @Post("allocations/:id/revise")
  @RequireRoles("ADMIN", "WAREHOUSE_KEEPER")
  revise(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: ReviseGoodReturnAllocationDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.service.revise(id, dto, actor(request), correlationId(request));
  }

  @Post("allocations/:id/cancel")
  @RequireRoles("ADMIN", "WAREHOUSE_KEEPER")
  cancel(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: CancelGoodReturnAllocationDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.service.cancel(id, dto, actor(request), correlationId(request));
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
