import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { Response } from "express";

import { API_CONFIG, type ApiConfig } from "../config";
import {
  ActivateAccountDto,
  ActivationOptionsDto,
  AssertionDto,
  LoginDto,
  LoginOptionsDto,
  RecoverAccountDto,
  RecoveryOptionsDto,
  StepUpDto,
} from "./identity.dto";
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

  @Post("activate/options")
  activationOptions(@Body() dto: ActivationOptionsDto) {
    return this.authService.activationOptions(dto);
  }

  @Post("activate")
  async activate(
    @Body() dto: ActivateAccountDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.authService.activate(dto, requireCorrelationId(request));
    this.setSessionCookie(response, result.sessionToken, result.cookieExpiresAt);
    return result.body;
  }

  @HttpCode(200)
  @Post("login/options")
  loginOptions(@Body() dto: LoginOptionsDto) {
    return this.authService.loginOptions(dto);
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
    this.setSessionCookie(response, result.sessionToken, result.cookieExpiresAt);
    return result.body;
  }

  @Post("refresh/options")
  refreshOptions(@Req() request: AuthenticatedRequest) {
    return this.authService.refreshOptions(requireSessionCookie(request));
  }

  @Post("refresh")
  async refresh(
    @Body() dto: AssertionDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.authService.refresh(
      dto,
      requireSessionCookie(request),
      requireCorrelationId(request),
    );
    this.setSessionCookie(response, result.sessionToken, result.cookieExpiresAt);
    return result.body;
  }

  @Post("recover/options")
  recoveryOptions(@Body() dto: RecoveryOptionsDto) {
    return this.authService.recoveryOptions(dto);
  }

  @Post("recover")
  async recover(
    @Body() dto: RecoverAccountDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.authService.recover(dto, requireCorrelationId(request));
    this.setSessionCookie(response, result.sessionToken, result.cookieExpiresAt);
    return result.body;
  }

  @Post("step-up/options")
  @UseGuards(SessionAuthGuard, CsrfGuard)
  stepUpOptions(@Req() request: AuthenticatedRequest) {
    return this.authService.stepUpOptions(requireActor(request));
  }

  @Post("step-up")
  @UseGuards(SessionAuthGuard, CsrfGuard)
  stepUp(@Body() dto: StepUpDto, @Req() request: AuthenticatedRequest) {
    return this.authService.stepUp(dto, requireActor(request), requireCorrelationId(request));
  }

  @Get("session")
  @UseGuards(SessionAuthGuard)
  async session(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const actor = requireActor(request);
    const result = await this.authService.currentUser(
      actor.deviceId,
      actor.employee.id,
      actor.sessionId,
      actor.sessionToken,
    );
    this.setSessionCookie(response, actor.sessionToken, result.sessionExpiresAt);
    return result;
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
    this.clearSessionCookie(response);
  }

  @HttpCode(204)
  @Post("logout-all")
  @UseGuards(SessionAuthGuard, CsrfGuard)
  async logoutAll(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const actor = requireActor(request);
    await this.repository.revokeAllSessions(
      actor.accountId,
      actor.employee.id,
      requireCorrelationId(request),
    );
    this.clearSessionCookie(response);
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

  private clearSessionCookie(response: Response): void {
    response.clearCookie(SESSION_COOKIE_NAME, {
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

function requireSessionCookie(request: AuthenticatedRequest): string {
  const header = request.headers.cookie;
  if (header !== undefined) {
    for (const part of header.split(";")) {
      const separator = part.indexOf("=");
      if (separator < 0 || part.slice(0, separator).trim() !== SESSION_COOKIE_NAME) continue;
      return decodeURIComponent(part.slice(separator + 1).trim());
    }
  }
  throw new UnauthorizedException({
    code: "AUTHENTICATION_REQUIRED",
    message: "Требуется повторный вход",
  });
}
