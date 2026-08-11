import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { CsrfGuard, SessionAuthGuard } from "../identity/identity.guards";
import type { AuthenticatedRequest } from "../identity/identity.types";
import {
  ControlCenterQueryDto,
  CreateReportJobDto,
  ProductionOutboundQueryDto,
} from "./report.dto";
import { ReportsService } from "./reports.service";

@ApiTags("Контроль и отчеты")
@Controller("reports")
@UseGuards(SessionAuthGuard, CsrfGuard)
export class ReportsController {
  constructor(private readonly service: ReportsService) {}

  @Get("control")
  control(@Query() query: ControlCenterQueryDto, @Req() request: AuthenticatedRequest) {
    return this.service.control(query.date, actor(request));
  }

  @Get("workspace")
  workspace(@Req() request: AuthenticatedRequest) {
    return this.service.workspace(actor(request));
  }

  @Get("production-outbound")
  productionOutbound(
    @Query() query: ProductionOutboundQueryDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.service.productionOutbound(query.dateFrom, query.dateTo, actor(request));
  }

  @Post("jobs")
  create(@Body() dto: CreateReportJobDto, @Req() request: AuthenticatedRequest) {
    return this.service.createJob(dto, actor(request), correlationId(request));
  }

  @Get("jobs/:id/download")
  async download(
    @Param("id", ParseUUIDPipe) id: string,
    @Req() request: AuthenticatedRequest,
    @Res() response: Response,
  ): Promise<void> {
    const file = await this.service.download(id, actor(request), correlationId(request));
    response.setHeader("content-type", file.contentType);
    response.setHeader(
      "content-disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    );
    response.setHeader("cache-control", "private, no-store");
    response.send(file.body);
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
