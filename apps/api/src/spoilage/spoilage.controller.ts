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
import {
  AcceptDriverSpoilageRequestDto,
  CheckExternalDocumentDto,
  CreateDriverSpoilageRequestDto,
  CreateWriteoffRequestDto,
  DecideWriteoffRequestDto,
} from "./spoilage.dto";
import { SpoilagePhotoService } from "./spoilage-photo.service";
import { SpoilageService } from "./spoilage.service";

@ApiTags("Порча и списание")
@Controller("spoilage")
@UseGuards(SessionAuthGuard, CsrfGuard, RolesGuard)
export class SpoilageController {
  constructor(
    private readonly service: SpoilageService,
    private readonly photos: SpoilagePhotoService,
  ) {}

  @Get("workspace")
  @RequireRoles("ADMIN", "MANAGER", "WAREHOUSE_KEEPER")
  workspace(@Req() request: AuthenticatedRequest) {
    return this.service.workspace(actor(request));
  }

  @Get("me/workspace")
  @RequireRoles("DRIVER")
  driverWorkspace(
    @Query("dispatchDate") dispatchDate: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.service.driverWorkspace(dispatchDate, actor(request));
  }

  @Post("photos")
  @RequireRoles("ADMIN", "WAREHOUSE_KEEPER")
  @ApiConsumes("multipart/form-data")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 10 * 1024 * 1024, files: 1 } }))
  uploadPhoto(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.photos.upload(file, actor(request).employee.id);
  }

  @Post("me/photos")
  @RequireRoles("DRIVER")
  @ApiConsumes("multipart/form-data")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 10 * 1024 * 1024, files: 1 } }))
  uploadDriverPhoto(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.photos.upload(file, actor(request).employee.id);
  }

  @Get("photos/:id")
  @RequireRoles("ADMIN", "MANAGER", "WAREHOUSE_KEEPER")
  async photo(
    @Param("id", ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const photo = await this.photos.read(id);
    response.setHeader("content-type", photo.contentType);
    response.setHeader("cache-control", "private, no-store, max-age=0");
    response.setHeader("content-security-policy", "default-src 'none'; sandbox");
    return new StreamableFile(photo.body);
  }

  @Post("requests")
  @RequireRoles("ADMIN", "WAREHOUSE_KEEPER")
  create(@Body() dto: CreateWriteoffRequestDto, @Req() request: AuthenticatedRequest) {
    return this.service.create(dto, actor(request), correlationId(request));
  }

  @Post("me/requests")
  @RequireRoles("DRIVER")
  createDriverRequest(
    @Body() dto: CreateDriverSpoilageRequestDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.service.createDriver(dto, actor(request), correlationId(request));
  }

  @Post("requests/:id/decision")
  @RequireRoles("ADMIN")
  decide(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: DecideWriteoffRequestDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.service.decide(id, dto, actor(request), correlationId(request));
  }

  @Post("requests/:id/acceptance")
  @RequireRoles("ADMIN", "WAREHOUSE_KEEPER")
  acceptDriverSpoilage(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: AcceptDriverSpoilageRequestDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.service.acceptDriverSpoilage(id, dto, actor(request), correlationId(request));
  }

  @Post("requests/:id/external-checks")
  @RequireRoles("ADMIN")
  check(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: CheckExternalDocumentDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.service.check(id, dto, actor(request), correlationId(request));
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
