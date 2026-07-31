import { Module } from "@nestjs/common";

import { CoreModule } from "../core.module";
import { ProductionController } from "./production.controller";
import { ProductionRepository } from "./production.repository";
import { ProductionService } from "./production.service";

@Module({
  imports: [CoreModule],
  controllers: [ProductionController],
  providers: [ProductionRepository, ProductionService],
})
export class ProductionModule {}
