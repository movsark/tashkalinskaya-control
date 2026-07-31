import { Body, Controller, Post, Req, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";

import { CsrfGuard, SessionAuthGuard, TerminalSessionAuthGuard } from "../identity/identity.guards";
import type { AuthenticatedRequest } from "../identity/identity.types";
import { ScanAttendanceQrDto } from "./attendance.dto";
import { AttendanceService } from "./attendance.service";

@ApiTags("Табель")
@Controller("attendance")
export class AttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  @Post("me/qr")
  @UseGuards(SessionAuthGuard, CsrfGuard)
  issueQr(@Req() request: AuthenticatedRequest) {
    return this.attendance.issueQr(requireActor(request));
  }

  @Post("terminal/scan")
  @UseGuards(TerminalSessionAuthGuard, CsrfGuard)
  scan(@Body() dto: ScanAttendanceQrDto, @Req() request: AuthenticatedRequest) {
    return this.attendance.scan(dto, requireTerminal(request), requireCorrelationId(request));
  }
}

function requireActor(request: AuthenticatedRequest) {
  if (request.actor === undefined) throw new Error("Authenticated actor is missing");
  return request.actor;
}

function requireTerminal(request: AuthenticatedRequest) {
  if (request.terminal === undefined) throw new Error("Authenticated terminal is missing");
  return request.terminal;
}

function requireCorrelationId(request: AuthenticatedRequest): string {
  if (request.correlationId === undefined) throw new Error("Correlation ID is missing");
  return request.correlationId;
}
