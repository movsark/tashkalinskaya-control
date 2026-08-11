import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { CsrfGuard, RequireRoles, RolesGuard, SessionAuthGuard } from "../identity/identity.guards";
import type { AuthenticatedRequest } from "../identity/identity.types";
import {
  ClaimWarehouseBatchDto,
  CreateWarehouseCorrectionDto,
  ExplainWarehouseDiscrepancyDto,
  ReceiveWarehouseBatchDto,
  ReleaseWarehouseBatchDto,
  ResolveWarehouseDiscrepancyDto,
  TransferWarehousePickupDto,
} from "./warehouse.dto";
import { WarehouseService } from "./warehouse.service";

@ApiTags("Склад")
@Controller("warehouse")
@UseGuards(SessionAuthGuard, CsrfGuard, RolesGuard)
export class WarehouseController {
  constructor(private readonly service: WarehouseService) {}
  @Get("workspace")
  @RequireRoles("ADMIN", "MANAGER", "WAREHOUSE_KEEPER", "WORKSHOP_MANAGER")
  workspace(@Req() r: AuthenticatedRequest) {
    return this.service.workspace(actor(r));
  }
  @Post("batches/:id/claim") @RequireRoles("ADMIN", "WAREHOUSE_KEEPER") claim(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() d: ClaimWarehouseBatchDto,
    @Req() r: AuthenticatedRequest,
  ) {
    return this.service.claim(id, d.version, actor(r), cid(r));
  }
  @Post("batches/:id/release") @RequireRoles("ADMIN") release(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() d: ReleaseWarehouseBatchDto,
    @Req() r: AuthenticatedRequest,
  ) {
    return this.service.release(id, d.reason, actor(r), cid(r));
  }
  @Post("batches/:id/receive") @RequireRoles("ADMIN", "WAREHOUSE_KEEPER") receive(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() d: ReceiveWarehouseBatchDto,
    @Req() r: AuthenticatedRequest,
  ) {
    return this.service.receive(id, d, actor(r), cid(r));
  }
  @Post("pickups/transfer") @RequireRoles("ADMIN", "WAREHOUSE_KEEPER") transferPickup(
    @Body() d: TransferWarehousePickupDto,
    @Req() r: AuthenticatedRequest,
  ) {
    return this.service.transferPickup(d, actor(r), cid(r));
  }
  @Post("discrepancies/:id/explain") @RequireRoles("ADMIN", "WORKSHOP_MANAGER") explain(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() d: ExplainWarehouseDiscrepancyDto,
    @Req() r: AuthenticatedRequest,
  ) {
    return this.service.explain(id, d, actor(r), cid(r));
  }
  @Post("discrepancies/:id/resolve") @RequireRoles("ADMIN") resolve(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() d: ResolveWarehouseDiscrepancyDto,
    @Req() r: AuthenticatedRequest,
  ) {
    return this.service.resolve(id, d, actor(r), cid(r));
  }
  @Post("corrections") @RequireRoles("ADMIN") correct(
    @Body() d: CreateWarehouseCorrectionDto,
    @Req() r: AuthenticatedRequest,
  ) {
    return this.service.correct(d, actor(r), cid(r));
  }
}
function actor(r: AuthenticatedRequest) {
  if (!r.actor) throw new Error("Authenticated actor missing");
  return r.actor;
}
function cid(r: AuthenticatedRequest) {
  if (!r.correlationId) throw new Error("Correlation ID missing");
  return r.correlationId;
}
