import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module";
import { ReportsController } from "./reports.controller";
import { ReportsRepository } from "./reports.repository";
import { ReportsService } from "./reports.service";

@Module({
  controllers: [ReportsController],
  imports: [IdentityModule],
  providers: [ReportsRepository, ReportsService],
})
export class ReportsModule {}
