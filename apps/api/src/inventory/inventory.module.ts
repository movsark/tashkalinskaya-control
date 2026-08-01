import { Module } from "@nestjs/common";

import { CoreModule } from "../core.module";
import { IdentityModule } from "../identity/identity.module";
import { InventoryController } from "./inventory.controller";
import { InventoryRepository } from "./inventory.repository";
import { InventoryService } from "./inventory.service";

@Module({
  imports: [CoreModule, IdentityModule],
  controllers: [InventoryController],
  providers: [InventoryRepository, InventoryService],
})
export class InventoryModule {}
