import { Module } from "@nestjs/common";

import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { EmployeesController } from "./employees.controller";
import { EmployeesService } from "./employees.service";
import { IdentityCryptoService } from "./identity-crypto.service";
import { CsrfGuard, RolesGuard, SessionAuthGuard } from "./identity.guards";
import { IdentityRepository } from "./identity.repository";

@Module({
  controllers: [AuthController, EmployeesController],
  providers: [
    AuthService,
    CsrfGuard,
    EmployeesService,
    IdentityCryptoService,
    IdentityRepository,
    RolesGuard,
    SessionAuthGuard,
  ],
})
export class IdentityModule {}
