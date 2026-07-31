import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";

import {
  CreateTerminalDto,
  PairTerminalDto,
  RevokeDeviceDto,
  TerminalPairingOptionsDto,
} from "./identity.dto";
import {
  CsrfGuard,
  RequireRoles,
  RolesGuard,
  SessionAuthGuard,
  StepUpGuard,
} from "./identity.guards";
import type { AuthenticatedRequest } from "./identity.types";
import { TerminalsService } from "./terminals.service";

@ApiTags("Фабричные терминалы")
@Controller("terminals")
export class TerminalsController {
  constructor(private readonly terminals: TerminalsService) {}

  @Get()
  @RequireRoles("ADMIN")
  @UseGuards(SessionAuthGuard, CsrfGuard, RolesGuard)
  list() {
    return this.terminals.list();
  }

  @Post()
  @RequireRoles("ADMIN")
  @UseGuards(SessionAuthGuard, CsrfGuard, RolesGuard, StepUpGuard)
  create(@Body() dto: CreateTerminalDto, @Req() request: AuthenticatedRequest) {
    const actor = requireActor(request);
    return this.terminals.create(dto, actor.employee.id, requireCorrelationId(request));
  }

  @Post("pair/options")
  pairingOptions(@Body() dto: TerminalPairingOptionsDto) {
    return this.terminals.pairingOptions(dto);
  }

  @Post("pair")
  pair(@Body() dto: PairTerminalDto) {
    return this.terminals.pair(dto);
  }

  @HttpCode(204)
  @Post(":terminalId/revoke")
  @RequireRoles("ADMIN")
  @UseGuards(SessionAuthGuard, CsrfGuard, RolesGuard, StepUpGuard)
  async revoke(
    @Param("terminalId") terminalId: string,
    @Body() dto: RevokeDeviceDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    const actor = requireActor(request);
    await this.terminals.revoke(
      terminalId,
      dto.reason,
      actor.employee.id,
      requireCorrelationId(request),
    );
  }
}

function requireCorrelationId(request: AuthenticatedRequest): string {
  if (request.correlationId === undefined) throw new Error("Correlation ID is missing");
  return request.correlationId;
}

function requireActor(request: AuthenticatedRequest) {
  if (request.actor === undefined) throw new Error("Authenticated actor is missing");
  return request.actor;
}
