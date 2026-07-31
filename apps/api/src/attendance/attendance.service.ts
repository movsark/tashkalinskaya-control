import { randomUUID } from "node:crypto";

import { Injectable, UnprocessableEntityException } from "@nestjs/common";
import type { AttendanceQrView, AttendanceScanResult } from "@tashkalinskaya/contracts";

import type { AuthenticatedActor, AuthenticatedTerminal } from "../identity/identity.types";
import { AttendanceCryptoService } from "./attendance-crypto.service";
import { AttendanceRepository } from "./attendance.repository";
import type { ScanAttendanceQrDto } from "./attendance.dto";

@Injectable()
export class AttendanceService {
  constructor(
    private readonly crypto: AttendanceCryptoService,
    private readonly repository: AttendanceRepository,
  ) {}

  async issueQr(actor: AuthenticatedActor): Promise<AttendanceQrView> {
    const secret = this.crypto.generateSecret();
    try {
      const token = await this.repository.issueToken({
        actor,
        tokenHash: this.crypto.hashSecret(secret),
        tokenId: randomUUID(),
      });
      return {
        acceptUntil: token.acceptUntil.toISOString(),
        action: token.action,
        businessDate: token.businessDate,
        issuedAt: token.issuedAt.toISOString(),
        lastEvent: token.lastEvent,
        payload: `tkc:a1:${secret}`,
        visibleUntil: token.visibleUntil.toISOString(),
      };
    } catch (error) {
      const coded = error as { code?: unknown; message?: unknown };
      if (typeof coded.code === "string" && typeof coded.message === "string") {
        throw new UnprocessableEntityException({ code: coded.code, message: coded.message });
      }
      throw error;
    }
  }

  async scan(
    dto: ScanAttendanceQrDto,
    terminal: AuthenticatedTerminal,
    correlationId: string,
  ): Promise<AttendanceScanResult> {
    const secret = dto.payload.slice("tkc:a1:".length);
    const outcome = await this.repository.scanToken({
      correlationId,
      idempotencyKey: dto.idempotencyKey,
      terminal,
      tokenHash: this.crypto.hashSecret(secret),
    });
    if (!outcome.ok) {
      throw new UnprocessableEntityException({ code: outcome.code, message: outcome.message });
    }
    return outcome.result;
  }
}
