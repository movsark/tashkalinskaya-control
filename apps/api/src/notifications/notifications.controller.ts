import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";

import { CsrfGuard, SessionAuthGuard } from "../identity/identity.guards";
import type { AuthenticatedRequest } from "../identity/identity.types";
import { CreatePushSubscriptionDto, UpdateNotificationPreferenceDto } from "./notification.dto";
import { NotificationsService } from "./notifications.service";

@ApiTags("Уведомления")
@Controller("notifications")
@UseGuards(SessionAuthGuard, CsrfGuard)
export class NotificationsController {
  constructor(private readonly service: NotificationsService) {}

  @Get("workspace")
  workspace(@Req() request: AuthenticatedRequest) {
    return this.service.workspace(actor(request));
  }

  @Post("subscriptions")
  subscribe(@Body() dto: CreatePushSubscriptionDto, @Req() request: AuthenticatedRequest) {
    return this.service.subscribe(dto, actor(request), correlationId(request));
  }

  @Delete("subscriptions/:id")
  @HttpCode(204)
  async revoke(
    @Param("id", ParseUUIDPipe) id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.service.revoke(id, actor(request), correlationId(request));
  }

  @Post("read-all")
  readAll(@Req() request: AuthenticatedRequest) {
    return this.service.readAll(actor(request));
  }

  @Post(":id/read")
  read(@Param("id", ParseUUIDPipe) id: string, @Req() request: AuthenticatedRequest) {
    return this.service.read(id, actor(request));
  }

  @Put("preference")
  updatePreference(
    @Body() dto: UpdateNotificationPreferenceDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.service.updatePreference(dto, actor(request));
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
