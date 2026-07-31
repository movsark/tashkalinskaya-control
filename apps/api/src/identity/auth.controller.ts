import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { Response } from "express";

import { API_CONFIG, type ApiConfig } from "../config";
import { ActivateAccountDto, LoginDto } from "./identity.dto";
import { CsrfGuard, SESSION_COOKIE_NAME, SessionAuthGuard } from "./identity.guards";
import type { AuthenticatedRequest } from "./identity.types";
import { IdentityRepository } from "./identity.repository";
import { AuthService } from "./auth.service";

@ApiTags("Авторизация")
@Controller("auth")
export class AuthController {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly authService: AuthService,
    private readonly repository: IdentityRepository,
  ) {}

  @Post("activate")
  async activate(
    @Body() dto: ActivateAccountDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.authService.activate(dto, requireCorrelationId(request));
    this.setSessionCookie(response, result.sessionToken, result.body.sessionExpiresAt);
    return result.body;
  }

  @HttpCode(200)
  @Post("login")
  async login(
    @Body() dto: LoginDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.authService.login(
      dto,
      requireCorrelationId(request),
      request.ip ?? request.socket.remoteAddress ?? "unknown",
    );
    this.setSessionCookie(response, result.sessionToken, result.body.sessionExpiresAt);
    return result.body;
  }

  @Get("session")
  @UseGuards(SessionAuthGuard)
  session(@Req() request: AuthenticatedRequest) {
    const actor = requireActor(request);
    return this.authService.currentUser(
      actor.deviceId,
      actor.employee.id,
      actor.sessionExpiresAt,
      actor.sessionToken,
    );
  }

  @HttpCode(204)
  @Post("logout")
  @UseGuards(SessionAuthGuard, CsrfGuard)
  async logout(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const actor = requireActor(request);
    await this.repository.revokeSession(
      actor.sessionId,
      actor.employee.id,
      requireCorrelationId(request),
    );
    response.clearCookie(SESSION_COOKIE_NAME, {
      httpOnly: true,
      path: "/api/v1",
      sameSite: "strict",
      secure:
        this.config.nodeEnvironment !== "development" && this.config.nodeEnvironment !== "test",
    });
  }

  private setSessionCookie(response: Response, token: string, expiresAt: string): void {
    response.cookie(SESSION_COOKIE_NAME, token, {
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
