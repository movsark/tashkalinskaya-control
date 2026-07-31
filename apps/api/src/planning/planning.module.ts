import { Module } from "@nestjs/common";

import { IdentityModule } from "../identity/identity.module";
import { PlanningController } from "./planning.controller";
import { PlanningRepository } from "./planning.repository";
import { PlanningService } from "./planning.service";

@Module({
  controllers: [PlanningController],
  imports: [IdentityModule],
  providers: [PlanningRepository, PlanningService],
})
export class PlanningModule {}
