import { Module } from "@nestjs/common";

import { IdentityModule } from "../identity/identity.module";
import { LogisticsController } from "./logistics.controller";
import { LogisticsRepository } from "./logistics.repository";
import { LogisticsService } from "./logistics.service";

@Module({
  controllers: [LogisticsController],
  imports: [IdentityModule],
  providers: [LogisticsRepository, LogisticsService],
})
export class LogisticsModule {}
