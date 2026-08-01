import { Module } from "@nestjs/common";

import { CoreModule } from "../core.module";
import { IdentityModule } from "../identity/identity.module";
import { ProductionController } from "./production.controller";
import { ProductionRepository } from "./production.repository";
import { ProductionService } from "./production.service";

@Module({
  imports: [CoreModule, IdentityModule],
  controllers: [ProductionController],
  providers: [ProductionRepository, ProductionService],
})
export class ProductionModule {}
