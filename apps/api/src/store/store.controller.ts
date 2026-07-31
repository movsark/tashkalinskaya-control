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
  CreateStoreLateRequestDto,
  DecideStoreLateRequestDto,
  SaveStoreDraftDto,
  SubmitStoreOrderDto,
} from "./store.dto";
import { StoreService } from "./store.service";

@ApiTags("Фирменный магазин")
@Controller("store")
@UseGuards(SessionAuthGuard, CsrfGuard, RolesGuard)
export class StoreController {
  constructor(private readonly store: StoreService) {}

  @Get("workspace")
  @RequireRoles("STORE_SELLER", "ADMIN", "MANAGER")
  workspace(@Req() request: AuthenticatedRequest) {
    return this.store.workspace(requireActorId(request), isPrivileged(request));
  }

  @Get("orders/:deliveryDate")
  @RequireRoles("STORE_SELLER", "ADMIN", "MANAGER")
  order(@Param("deliveryDate") deliveryDate: string, @Req() request: AuthenticatedRequest) {
    return this.store.workspaceForDate(
      deliveryDate,
      requireActorId(request),
      isPrivileged(request),
    );
  }

  @Put("orders/:deliveryDate/draft")
  @RequireRoles("STORE_SELLER", "ADMIN")
  saveDraft(
    @Param("deliveryDate") deliveryDate: string,
    @Body() dto: SaveStoreDraftDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.store.saveDraft(
      deliveryDate,
      dto,
      requireActorId(request),
      activeWriteRole(request),
      requireCorrelationId(request),
    );
  }

  @Post("orders/:deliveryDate/submit")
  @RequireRoles("STORE_SELLER", "ADMIN")
  submit(
    @Param("deliveryDate") deliveryDate: string,
    @Body() dto: SubmitStoreOrderDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.store.submit(
      deliveryDate,
      dto,
      requireActorId(request),
      activeWriteRole(request),
      requireCorrelationId(request),
    );
  }

  @Post("orders/:deliveryDate/late-requests")
  @RequireRoles("STORE_SELLER", "ADMIN")
  createLateRequest(
    @Param("deliveryDate") deliveryDate: string,
    @Body() dto: CreateStoreLateRequestDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.store.createLateRequest(
      deliveryDate,
      dto,
      requireActorId(request),
      activeWriteRole(request),
      requireCorrelationId(request),
    );
  }

  @Get("late-requests")
  @RequireRoles("ADMIN", "MANAGER")
  lateRequests() {
    return this.store.lateRequests();
  }

  @Post("late-requests/:requestId/decision")
  @RequireRoles("ADMIN")
  decideLateRequest(
    @Param("requestId", ParseUUIDPipe) requestId: string,
    @Body() dto: DecideStoreLateRequestDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.store.decideLateRequest(
      requestId,
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

function isPrivileged(request: AuthenticatedRequest): boolean {
  return request.actor?.roles.some((role) => ["ADMIN", "MANAGER"].includes(role.roleCode)) ?? false;
}

function activeWriteRole(request: AuthenticatedRequest): "ADMIN" | "STORE_SELLER" {
  return request.actor?.roles.some((role) => role.roleCode === "ADMIN") ? "ADMIN" : "STORE_SELLER";
}
