import { Module } from "@nestjs/common";

import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { EmployeesController } from "./employees.controller";
import { EmployeesService } from "./employees.service";
import { DeviceSecurityRepository } from "./device-security.repository";
import { IdentityCryptoService } from "./identity-crypto.service";
import {
  CsrfGuard,
  RolesGuard,
  SessionAuthGuard,
  StepUpGuard,
  TerminalSessionAuthGuard,
} from "./identity.guards";
import { IdentityRepository } from "./identity.repository";
import { SmsRuService } from "./sms-ru.service";
import { TerminalsController } from "./terminals.controller";
import { TerminalsService } from "./terminals.service";
import { WebAuthnService } from "./webauthn.service";

@Module({
  controllers: [AuthController, EmployeesController, TerminalsController],
  providers: [
    AuthService,
    CsrfGuard,
    DeviceSecurityRepository,
    EmployeesService,
    IdentityCryptoService,
    IdentityRepository,
    RolesGuard,
    SessionAuthGuard,
    SmsRuService,
    StepUpGuard,
    TerminalSessionAuthGuard,
    TerminalsService,
    WebAuthnService,
  ],
  exports: [
    CsrfGuard,
    DeviceSecurityRepository,
    IdentityCryptoService,
    IdentityRepository,
    RolesGuard,
    SessionAuthGuard,
    StepUpGuard,
    TerminalSessionAuthGuard,
  ],
})
export class IdentityModule {}
