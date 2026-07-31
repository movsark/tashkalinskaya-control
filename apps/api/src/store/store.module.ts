import { Module } from "@nestjs/common";

import { IdentityModule } from "../identity/identity.module";
import { StoreController } from "./store.controller";
import { StoreRepository } from "./store.repository";
import { StoreService } from "./store.service";

@Module({
  controllers: [StoreController],
  imports: [IdentityModule],
  providers: [StoreRepository, StoreService],
})
export class StoreModule {}
