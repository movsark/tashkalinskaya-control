import { Module } from "@nestjs/common";

import { CoreModule } from "../core.module";
import { IdentityModule } from "../identity/identity.module";
import { LoadingController } from "./loading.controller";
import { LoadingRepository } from "./loading.repository";
import { LoadingService } from "./loading.service";

@Module({
  imports: [CoreModule, IdentityModule],
  controllers: [LoadingController],
  providers: [LoadingRepository, LoadingService],
})
export class LoadingModule {}
