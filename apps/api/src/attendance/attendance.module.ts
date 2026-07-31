import { Module } from "@nestjs/common";

import { IdentityModule } from "../identity/identity.module";
import { AttendanceController } from "./attendance.controller";
import { AttendanceCryptoService } from "./attendance-crypto.service";
import { AttendanceRepository } from "./attendance.repository";
import { AttendanceService } from "./attendance.service";

@Module({
  controllers: [AttendanceController],
  imports: [IdentityModule],
  providers: [AttendanceCryptoService, AttendanceRepository, AttendanceService],
})
export class AttendanceModule {}
