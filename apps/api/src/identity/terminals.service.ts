import { Injectable, UnauthorizedException } from "@nestjs/common";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";

import type { CreateTerminalDto, PairTerminalDto, TerminalPairingOptionsDto } from "./identity.dto";
import { DeviceSecurityRepository } from "./device-security.repository";
import { IdentityCryptoService } from "./identity-crypto.service";
import { WebAuthnService } from "./webauthn.service";

@Injectable()
export class TerminalsService {
  constructor(
    private readonly crypto: IdentityCryptoService,
    private readonly repository: DeviceSecurityRepository,
    private readonly webauthn: WebAuthnService,
  ) {}

  list() {
    return this.repository.listTerminals();
  }

  async create(
    dto: CreateTerminalDto,
    actorEmployeeId: string,
    correlationId: string,
  ): Promise<{ expiresAt: string; pairingCode: string; terminalId: string }> {
    const pairingCode = this.crypto.generateAccessCode();
    const result = await this.repository.createTerminal({
      actorEmployeeId,
      correlationId,
      ...(dto.departmentId === undefined ? {} : { departmentId: dto.departmentId }),
      locationLabel: dto.locationLabel.trim(),
      pairingTokenHash: this.crypto.hashAccessCode(pairingCode),
      terminalCode: dto.terminalCode.trim().toLocaleUpperCase("ru-RU"),
    });
    return {
      expiresAt: result.expiresAt.toISOString(),
      pairingCode,
      terminalId: result.id,
    };
  }

  async pairingOptions(dto: TerminalPairingOptionsDto) {
    const terminalCode = dto.terminalCode.trim().toLocaleUpperCase("ru-RU");
    const terminal = await this.repository.findTerminalByCode(terminalCode);
    const tokenHash = this.crypto.hashAccessCode(dto.pairingCode);
    if (
      terminal === null ||
      terminal.status !== "PENDING" ||
      !(await this.repository.validTerminalPairingToken(terminal.id, tokenHash))
    ) {
      throw pairingFailed();
    }
    return this.webauthn.registrationOptions({
      displayName: terminal.locationLabel,
      factoryTerminalId: terminal.id,
      purpose: "TERMINAL_PAIRING",
      userId: terminal.id,
      userName: `terminal:${terminal.terminalCode}`,
    });
  }

  async pair(dto: PairTerminalDto): Promise<{ paired: true; terminalId: string }> {
    const terminalCode = dto.terminalCode.trim().toLocaleUpperCase("ru-RU");
    const terminal = await this.repository.findTerminalByCode(terminalCode);
    const tokenHash = this.crypto.hashAccessCode(dto.pairingCode);
    if (
      terminal === null ||
      terminal.status !== "PENDING" ||
      !(await this.repository.validTerminalPairingToken(terminal.id, tokenHash))
    ) {
      throw pairingFailed();
    }
    const credential = await this.webauthn.verifyRegistration({
      challengeId: dto.challengeId,
      factoryTerminalId: terminal.id,
      purpose: "TERMINAL_PAIRING",
      response: dto.credential as unknown as RegistrationResponseJSON,
    });
    await this.repository.pairTerminal({
      credential,
      terminalId: terminal.id,
      tokenHash,
    });
    return { paired: true, terminalId: terminal.id };
  }

  async revoke(
    terminalId: string,
    reason: string,
    actorEmployeeId: string,
    correlationId: string,
  ): Promise<void> {
    await this.repository.revokeTerminal({
      actorEmployeeId,
      correlationId,
      reason: reason.trim(),
      terminalId,
    });
  }
}

function pairingFailed(): UnauthorizedException {
  return new UnauthorizedException({
    code: "TERMINAL_PAIRING_FAILED",
    message: "Не удалось привязать фабричный планшет",
  });
}
