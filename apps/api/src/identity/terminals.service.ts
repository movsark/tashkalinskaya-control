import { randomUUID } from "node:crypto";

import { Injectable, UnauthorizedException } from "@nestjs/common";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import type { TerminalSessionView } from "@tashkalinskaya/contracts";

import type {
  CreateTerminalDto,
  PairTerminalDto,
  TerminalLoginDto,
  TerminalLoginOptionsDto,
  TerminalPairingOptionsDto,
} from "./identity.dto";
import {
  DeviceSecurityRepository,
  type FactoryTerminalRecord,
  type NewTerminalSession,
} from "./device-security.repository";
import { IdentityCryptoService } from "./identity-crypto.service";
import type { AuthenticatedTerminal } from "./identity.types";
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

  async pair(dto: PairTerminalDto): Promise<TerminalSessionResult> {
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
    const sessionToken = this.crypto.generateSessionToken();
    const session = this.createTerminalSession(terminal.id, sessionToken);
    await this.repository.pairTerminal({
      credential,
      session,
      terminalId: terminal.id,
      tokenHash,
    });
    return this.sessionResult(terminal, session, sessionToken);
  }

  async loginOptions(dto: TerminalLoginOptionsDto) {
    const terminalCode = dto.terminalCode.trim().toLocaleUpperCase("ru-RU");
    const terminal = await this.repository.findActiveTerminalDevice(terminalCode);
    if (terminal === null) throw pairingFailed();
    return this.webauthn.terminalAuthenticationOptions({
      purpose: "TERMINAL_LOGIN",
      terminal,
    });
  }

  async login(dto: TerminalLoginDto, correlationId: string): Promise<TerminalSessionResult> {
    const terminalCode = dto.terminalCode.trim().toLocaleUpperCase("ru-RU");
    const terminal = await this.repository.findActiveTerminalDevice(terminalCode);
    if (terminal === null) throw pairingFailed();
    const counter = await this.webauthn.verifyTerminalAuthentication({
      challengeId: dto.challengeId,
      purpose: "TERMINAL_LOGIN",
      response: dto.credential as unknown as AuthenticationResponseJSON,
      terminal,
    });
    const sessionToken = this.crypto.generateSessionToken();
    const session = this.createTerminalSession(terminal.id, sessionToken);
    await this.repository.createTerminalSession({ correlationId, session });
    await this.repository.updateTerminalCounter(terminal.id, counter);
    return this.sessionResult(terminal, session, sessionToken);
  }

  currentSession(terminal: AuthenticatedTerminal) {
    return {
      csrfToken: this.crypto.createCsrfToken(terminal.sessionToken),
      departmentId: terminal.departmentId,
      locationLabel: terminal.locationLabel,
      sessionExpiresAt: terminal.sessionExpiresAt.toISOString(),
      terminalCode: terminal.terminalCode,
      terminalId: terminal.id,
    };
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

  private createTerminalSession(terminalId: string, sessionToken: string): NewTerminalSession {
    const now = Date.now();
    return {
      absoluteExpiresAt: new Date(now + 30 * 24 * 60 * 60 * 1000),
      accessExpiresAt: new Date(now + 24 * 60 * 60 * 1000),
      id: randomUUID(),
      terminalId,
      tokenHash: this.crypto.hashSessionToken(sessionToken),
    };
  }

  private sessionResult(
    terminal: Pick<FactoryTerminalRecord, "departmentId" | "id" | "locationLabel" | "terminalCode">,
    session: NewTerminalSession,
    sessionToken: string,
  ): TerminalSessionResult {
    return {
      body: {
        csrfToken: this.crypto.createCsrfToken(sessionToken),
        departmentId: terminal.departmentId,
        locationLabel: terminal.locationLabel,
        sessionExpiresAt: session.accessExpiresAt.toISOString(),
        terminalCode: terminal.terminalCode,
        terminalId: terminal.id,
      },
      cookieExpiresAt: session.accessExpiresAt.toISOString(),
      sessionToken,
    };
  }
}

interface TerminalSessionResult {
  readonly body: TerminalSessionView;
  readonly cookieExpiresAt: string;
  readonly sessionToken: string;
}

function pairingFailed(): UnauthorizedException {
  return new UnauthorizedException({
    code: "TERMINAL_PAIRING_FAILED",
    message: "Не удалось привязать фабричный планшет",
  });
}
