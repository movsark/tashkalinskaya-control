import { createHash, randomBytes } from "node:crypto";

import { Injectable } from "@nestjs/common";

@Injectable()
export class AttendanceCryptoService {
  generateSecret(): string {
    return randomBytes(32).toString("base64url");
  }

  hashSecret(secret: string): string {
    return createHash("sha256").update(secret, "utf8").digest("hex");
  }
}
