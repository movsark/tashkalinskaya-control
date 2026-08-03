import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";

import {
  CreateEmployeeDto,
  CreateEmployeeInvitationDto,
  DeleteInvitedEmployeeDto,
  IssueRecoveryDto,
  ReplaceRolesDto,
  RevokeDeviceDto,
  UpdateEmployeeStatusDto,
  UpdateEmployeeProfileDto,
} from "./identity.dto";
import { CsrfGuard, RequireRoles, RolesGuard, SessionAuthGuard } from "./identity.guards";
import type { AuthenticatedRequest } from "./identity.types";
import { EmployeesService } from "./employees.service";

@ApiTags("Сотрудники")
@Controller("employees")
@UseGuards(SessionAuthGuard, CsrfGuard, RolesGuard)
export class EmployeesController {
  constructor(private readonly employees: EmployeesService) {}

  @Get()
  @RequireRoles("ADMIN", "MANAGER", "ACCOUNTANT")
  list() {
    return this.employees.list();
  }

  @Get(":employeeId/access")
  @RequireRoles("ADMIN")
  access(@Param("employeeId") employeeId: string) {
    return this.employees.access(employeeId);
  }

  @Post()
  @RequireRoles("ADMIN")
  create(@Body() dto: CreateEmployeeDto, @Req() request: AuthenticatedRequest) {
    const actor = requireActor(request);
    return this.employees.create(dto, actor.employee.id, requireCorrelationId(request));
  }

  @Get("invitations/options")
  @RequireRoles("ADMIN")
  invitationOptions() {
    return this.employees.invitationOptions();
  }

  @Post("invitations")
  @RequireRoles("ADMIN")
  createInvitation(@Body() dto: CreateEmployeeInvitationDto, @Req() request: AuthenticatedRequest) {
    const actor = requireActor(request);
    return this.employees.createInvitation(dto, actor.employee.id, requireCorrelationId(request));
  }

  @Patch(":employeeId/status")
  @RequireRoles("ADMIN")
  updateStatus(
    @Param("employeeId") employeeId: string,
    @Body() dto: UpdateEmployeeStatusDto,
    @Req() request: AuthenticatedRequest,
  ) {
    const actor = requireActor(request);
    return this.employees.updateStatus(
      employeeId,
      dto,
      actor.employee.id,
      requireCorrelationId(request),
    );
  }

  @Patch(":employeeId/profile")
  @RequireRoles("ADMIN")
  updateProfile(
    @Param("employeeId") employeeId: string,
    @Body() dto: UpdateEmployeeProfileDto,
    @Req() request: AuthenticatedRequest,
  ) {
    const actor = requireActor(request);
    return this.employees.updateProfile(
      employeeId,
      dto,
      actor.employee.id,
      requireCorrelationId(request),
    );
  }

  @HttpCode(204)
  @Delete(":employeeId")
  @RequireRoles("ADMIN")
  async deleteInvitedEmployee(
    @Param("employeeId") employeeId: string,
    @Body() dto: DeleteInvitedEmployeeDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    const actor = requireActor(request);
    await this.employees.deleteInvitedEmployee(
      employeeId,
      dto,
      actor.employee.id,
      requireCorrelationId(request),
    );
  }

  @Post(":employeeId/activation")
  @RequireRoles("ADMIN")
  reissueActivation(
    @Param("employeeId") employeeId: string,
    @Body() dto: IssueRecoveryDto,
    @Req() request: AuthenticatedRequest,
  ) {
    const actor = requireActor(request);
    return this.employees.reissueActivation(
      employeeId,
      dto,
      actor.employee.id,
      requireCorrelationId(request),
    );
  }

  @Put(":employeeId/roles")
  @RequireRoles("ADMIN")
  replaceRoles(
    @Param("employeeId") employeeId: string,
    @Body() dto: ReplaceRolesDto,
    @Req() request: AuthenticatedRequest,
  ) {
    const actor = requireActor(request);
    return this.employees.replaceRoles(
      employeeId,
      dto,
      actor.employee.id,
      requireCorrelationId(request),
    );
  }

  @HttpCode(204)
  @Post("devices/:deviceId/revoke")
  @RequireRoles("ADMIN")
  async revokeDevice(
    @Param("deviceId") deviceId: string,
    @Body() dto: RevokeDeviceDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    const actor = requireActor(request);
    await this.employees.revokeDevice(
      deviceId,
      dto,
      actor.employee.id,
      requireCorrelationId(request),
    );
  }

  @Post(":employeeId/recovery")
  @RequireRoles("ADMIN")
  issueRecovery(
    @Param("employeeId") employeeId: string,
    @Body() dto: IssueRecoveryDto,
    @Req() request: AuthenticatedRequest,
  ) {
    const actor = requireActor(request);
    return this.employees.issueRecovery(
      employeeId,
      dto,
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
