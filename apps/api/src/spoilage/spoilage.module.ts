import { Module } from "@nestjs/common";
import { CoreModule } from "../core.module";
import { PrivateObjectStorage } from "./private-object-storage.service";
import { SpoilageController } from "./spoilage.controller";
import { SpoilagePhotoService } from "./spoilage-photo.service";
import { SpoilageRepository } from "./spoilage.repository";
import { SpoilageService } from "./spoilage.service";

@Module({
  imports: [CoreModule],
  controllers: [SpoilageController],
  providers: [PrivateObjectStorage, SpoilagePhotoService, SpoilageRepository, SpoilageService],
})
export class SpoilageModule {}
