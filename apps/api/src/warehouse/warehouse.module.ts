import { Module } from "@nestjs/common";
import { CoreModule } from "../core.module";
import { WarehouseController } from "./warehouse.controller";
import { WarehouseRepository } from "./warehouse.repository";
import { WarehouseService } from "./warehouse.service";
@Module({
  imports: [CoreModule],
  controllers: [WarehouseController],
  providers: [WarehouseRepository, WarehouseService],
})
export class WarehouseModule {}
