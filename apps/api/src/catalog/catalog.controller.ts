import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiConsumes, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";

import { CsrfGuard, RequireRoles, RolesGuard, SessionAuthGuard } from "../identity/identity.guards";
import type { AuthenticatedRequest } from "../identity/identity.types";
import { ApplyCatalogImportDto, PreviewCatalogImportDto } from "./catalog.dto";
import { CatalogService } from "./catalog.service";

@ApiTags("Справочники и импорт")
@Controller("catalog")
@UseGuards(SessionAuthGuard, CsrfGuard, RolesGuard)
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get("products")
  @RequireRoles("ADMIN", "MANAGER", "WORKSHOP_MANAGER", "WAREHOUSE_KEEPER", "DRIVER")
  products() {
    return this.catalog.listProducts();
  }

  @Get("imports/template")
  @RequireRoles("ADMIN")
  async template(@Res({ passthrough: true }) response: Response): Promise<StreamableFile> {
    const template = await this.catalog.loadTemplate();
    response.setHeader(
      "content-disposition",
      "attachment; filename*=UTF-8''%D0%A8%D0%B0%D0%B1%D0%BB%D0%BE%D0%BD_%D0%B8%D0%BC%D0%BF%D0%BE%D1%80%D1%82%D0%B0_v1.0.xlsx",
    );
    response.setHeader(
      "content-type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    return new StreamableFile(template);
  }

  @Post("imports/preview")
  @RequireRoles("ADMIN")
  @ApiConsumes("multipart/form-data")
  @UseInterceptors(
    FileInterceptor("file", {
      limits: { fileSize: 10 * 1024 * 1024, files: 1 },
    }),
  )
  preview(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: PreviewCatalogImportDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.catalog.preview(file, dto, requireActorId(request), requireCorrelationId(request));
  }

  @Get("imports/:batchId")
  @RequireRoles("ADMIN", "MANAGER")
  importPreview(@Param("batchId", ParseUUIDPipe) batchId: string) {
    return this.catalog.getImport(batchId);
  }

  @Get("imports/:batchId/issues.csv")
  @RequireRoles("ADMIN", "MANAGER")
  async issueReport(
    @Param("batchId", ParseUUIDPipe) batchId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const report = await this.catalog.issueReport(batchId);
    response.setHeader("content-type", "text/csv; charset=utf-8");
    response.setHeader(
      "content-disposition",
      `attachment; filename="import-${batchId}-issues.csv"`,
    );
    return new StreamableFile(Buffer.from(report, "utf8"));
  }

  @Post("imports/:batchId/apply")
  @RequireRoles("ADMIN")
  apply(
    @Param("batchId", ParseUUIDPipe) batchId: string,
    @Body() dto: ApplyCatalogImportDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.catalog.apply(batchId, dto, requireActorId(request), requireCorrelationId(request));
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
