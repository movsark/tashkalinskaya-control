import { createCipheriv, createHash, randomBytes } from "node:crypto";

export interface StoredCiphertext {
  readonly authTag: Buffer;
  readonly ciphertext: Buffer;
  readonly iv: Buffer;
}

export function encryptPushSubscription(
  value: {
    endpoint: string;
    expirationTime: number | null;
    keys: { auth: string; p256dh: string };
  },
  secret: string,
): StoredCiphertext {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(secret).digest(), iv);
  cipher.setAAD(Buffer.from("tashkalinskaya:web-push:v1"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return { authTag: cipher.getAuthTag(), ciphertext, iv };
}
