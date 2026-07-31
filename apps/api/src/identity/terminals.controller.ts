import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { Response } from "express";

import { API_CONFIG, type ApiConfig } from "../config";

import {
  CreateTerminalDto,
  PairTerminalDto,
  RevokeDeviceDto,
  TerminalLoginDto,
  TerminalLoginOptionsDto,
  TerminalPairingOptionsDto,
} from "./identity.dto";
import {
  CsrfGuard,
  RequireRoles,
  RolesGuard,
  SessionAuthGuard,
  StepUpGuard,
  TERMINAL_SESSION_COOKIE_NAME,
  TerminalSessionAuthGuard,
} from "./identity.guards";
import type { AuthenticatedRequest } from "./identity.types";
import { TerminalsService } from "./terminals.service";

@ApiTags("Фабричные терминалы")
@Controller("terminals")
export class TerminalsController {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly terminals: TerminalsService,
  ) {}

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
  async pair(@Body() dto: PairTerminalDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.terminals.pair(dto);
    this.setTerminalCookie(response, result.sessionToken, result.cookieExpiresAt);
    return result.body;
  }

  @Post("login/options")
  loginOptions(@Body() dto: TerminalLoginOptionsDto) {
    return this.terminals.loginOptions(dto);
  }

  @Post("login")
  async login(
    @Body() dto: TerminalLoginDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.terminals.login(dto, requireCorrelationId(request));
    this.setTerminalCookie(response, result.sessionToken, result.cookieExpiresAt);
    return result.body;
  }

  @Get("session")
  @UseGuards(TerminalSessionAuthGuard)
  session(@Req() request: AuthenticatedRequest) {
    return this.terminals.currentSession(requireTerminal(request));
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

  private setTerminalCookie(response: Response, token: string, expiresAt: string): void {
    response.cookie(TERMINAL_SESSION_COOKIE_NAME, token, {
      expires: new Date(expiresAt),
      httpOnly: true,
      path: "/api/v1",
      sameSite: "strict",
      secure:
        this.config.nodeEnvironment !== "development" && this.config.nodeEnvironment !== "test",
    });
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

function requireTerminal(request: AuthenticatedRequest) {
  if (request.terminal === undefined) throw new Error("Authenticated terminal is missing");
  return request.terminal;
}
