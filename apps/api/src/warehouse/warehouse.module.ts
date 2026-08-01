import { Module } from "@nestjs/common";
import { CoreModule } from "../core.module";
import { IdentityModule } from "../identity/identity.module";
import { WarehouseController } from "./warehouse.controller";
import { WarehouseRepository } from "./warehouse.repository";
import { WarehouseService } from "./warehouse.service";
@Module({
  imports: [CoreModule, IdentityModule],
  controllers: [WarehouseController],
  providers: [WarehouseRepository, WarehouseService],
})
export class WarehouseModule {}
