import { Controller, Get, Res } from "@nestjs/common";
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from "@nestjs/swagger";
import type { Response } from "express";

import { HealthService } from "./health.service";

@ApiTags("health")
@Controller("health")
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get("live")
  @ApiOperation({ summary: "Проверка процесса API" })
  @ApiOkResponse({ description: "Процесс отвечает" })
  getLiveness() {
    return this.healthService.getLiveness();
  }

  @Get("ready")
  @ApiOperation({ summary: "Проверка готовности API и PostgreSQL" })
  @ApiOkResponse({ description: "API готов принимать трафик" })
  @ApiServiceUnavailableResponse({ description: "Обязательная зависимость недоступна" })
  async getReadiness(@Res({ passthrough: true }) response: Response) {
    const health = await this.healthService.getReadiness();
    if (health.state === "degraded") {
      response.status(503);
    }
    return health;
  }
}
