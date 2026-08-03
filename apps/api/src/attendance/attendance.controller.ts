import { Body, Controller, Get, Param, Post, Put, Query, Req, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";

import {
  CsrfGuard,
  RequireRoles,
  RolesGuard,
  SessionAuthGuard,
  TerminalSessionAuthGuard,
} from "../identity/identity.guards";
import type { AuthenticatedRequest } from "../identity/identity.types";
import {
  AttendanceControlQueryDto,
  AttendanceCorrectionQueryDto,
  AssignEmployeeAttendanceDto,
  CreateAttendanceDepartmentDto,
  CreateAttendanceCorrectionDto,
  CreateAttendanceShiftDto,
  DecideAttendanceCorrectionDto,
  ManualAttendanceDto,
  ScanAttendanceQrDto,
} from "./attendance.dto";
import { AttendanceService } from "./attendance.service";

@ApiTags("Табель")
@Controller("attendance")
export class AttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  @Get("setup")
  @UseGuards(SessionAuthGuard, CsrfGuard, RolesGuard)
  @RequireRoles("ADMIN")
  setup() {
    return this.attendance.setup();
  }

  @Post("setup/departments")
  @UseGuards(SessionAuthGuard, CsrfGuard, RolesGuard)
  @RequireRoles("ADMIN")
  createDepartment(
    @Body() dto: CreateAttendanceDepartmentDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.attendance.createDepartment(
      dto,
      requireActor(request),
      requireCorrelationId(request),
    );
  }

  @Post("setup/shifts")
  @UseGuards(SessionAuthGuard, CsrfGuard, RolesGuard)
  @RequireRoles("ADMIN")
  createShift(@Body() dto: CreateAttendanceShiftDto, @Req() request: AuthenticatedRequest) {
    return this.attendance.createShift(dto, requireActor(request), requireCorrelationId(request));
  }

  @Get("setup/employees/:employeeId")
  @UseGuards(SessionAuthGuard, CsrfGuard, RolesGuard)
  @RequireRoles("ADMIN")
  assignment(@Param("employeeId") employeeId: string) {
    return this.attendance.assignment(employeeId);
  }

  @Put("setup/employees/:employeeId")
  @UseGuards(SessionAuthGuard, CsrfGuard, RolesGuard)
  @RequireRoles("ADMIN")
  assignEmployee(
    @Param("employeeId") employeeId: string,
    @Body() dto: AssignEmployeeAttendanceDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.attendance.assignEmployee(
      employeeId,
      dto,
      requireActor(request),
      requireCorrelationId(request),
    );
  }

  @Get("control")
  @UseGuards(SessionAuthGuard, CsrfGuard)
  control(@Query() query: AttendanceControlQueryDto, @Req() request: AuthenticatedRequest) {
    return this.attendance.control(query, requireActor(request));
  }

  @Get("manual-reasons")
  @UseGuards(SessionAuthGuard, CsrfGuard)
  manualReasons(@Req() request: AuthenticatedRequest) {
    return this.attendance.listManualReasons(requireActor(request));
  }

  @Post("manual")
  @UseGuards(SessionAuthGuard, CsrfGuard)
  manual(@Body() dto: ManualAttendanceDto, @Req() request: AuthenticatedRequest) {
    return this.attendance.recordManual(dto, requireActor(request), requireCorrelationId(request));
  }

  @Get("corrections")
  @UseGuards(SessionAuthGuard, CsrfGuard)
  corrections(@Query() query: AttendanceCorrectionQueryDto, @Req() request: AuthenticatedRequest) {
    return this.attendance.listCorrections(query, requireActor(request));
  }

  @Post("corrections")
  @UseGuards(SessionAuthGuard, CsrfGuard)
  createCorrection(
    @Body() dto: CreateAttendanceCorrectionDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.attendance.createCorrection(
      dto,
      requireActor(request),
      requireCorrelationId(request),
    );
  }

  @Post("corrections/:correctionId/decision")
  @UseGuards(SessionAuthGuard, CsrfGuard)
  decideCorrection(
    @Param("correctionId") correctionId: string,
    @Body() dto: DecideAttendanceCorrectionDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.attendance.decideCorrection(
      correctionId,
      dto,
      requireActor(request),
      requireCorrelationId(request),
    );
  }

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
