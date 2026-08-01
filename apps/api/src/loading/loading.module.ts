import { Module } from "@nestjs/common";

import { CoreModule } from "../core.module";
import { LoadingController } from "./loading.controller";
import { LoadingRepository } from "./loading.repository";
import { LoadingService } from "./loading.service";

@Module({
  imports: [CoreModule],
  controllers: [LoadingController],
  providers: [LoadingRepository, LoadingService],
})
export class LoadingModule {}
