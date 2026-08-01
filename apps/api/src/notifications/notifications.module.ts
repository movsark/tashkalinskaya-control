import { Module } from "@nestjs/common";
import { CoreModule } from "../core.module";
import { IdentityModule } from "../identity/identity.module";
import { NotificationsController } from "./notifications.controller";
import { NotificationsRepository } from "./notifications.repository";
import { NotificationsService } from "./notifications.service";

@Module({
  imports: [CoreModule, IdentityModule],
  controllers: [NotificationsController],
  providers: [NotificationsRepository, NotificationsService],
})
export class NotificationsModule {}
