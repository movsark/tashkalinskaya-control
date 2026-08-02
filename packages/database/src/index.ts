import { createHash } from "node:crypto";

import { Pool } from "pg";

export interface DatabasePoolOptions {
  readonly applicationName: string;
  readonly connectionString: string;
  readonly maxConnections?: number;
  readonly sslMode?: "disable" | "require";
  readonly tlsFingerprintSha256?: string;
}

export function isDatabaseConfigured(
  connectionString: string | undefined,
): connectionString is string {
  return typeof connectionString === "string" && connectionString.trim().length > 0;
}

export function createDatabasePool(options: DatabasePoolOptions): Pool {
  const connectionString =
    options.sslMode === "require"
      ? connectionStringWithoutSslOverrides(options.connectionString)
      : options.connectionString;
  const configuredTlsFingerprint = options.tlsFingerprintSha256 ?? process.env.DATABASE_TLS_SHA256;
  const tlsFingerprintSha256 =
    options.sslMode === "require" && configuredTlsFingerprint !== undefined
      ? normalizeSha256Fingerprint(configuredTlsFingerprint)
      : undefined;

  return new Pool({
    application_name: options.applicationName,
    connectionString,
    max: options.maxConnections ?? 10,
    ...(options.sslMode === "require"
      ? {
          ssl: {
            // A Timeweb private-IP cluster does not expose its rotating root CA
            // in the control panel. Keep TLS encryption and pin the exact leaf
            // certificate for that cluster when its SHA-256 fingerprint is set.
            ...(tlsFingerprintSha256 === undefined
              ? { checkServerIdentity: () => undefined, rejectUnauthorized: true }
              : { rejectUnauthorized: false }),
          },
          ...(tlsFingerprintSha256 === undefined
            ? {}
            : {
                onConnect: (client) => {
                  assertPinnedTlsCertificate(client, tlsFingerprintSha256);
                },
              }),
        }
      : {}),
  });
}

export async function checkDatabase(pool: Pool): Promise<void> {
  const result = await pool.query<{ current_time: Date }>("select now() as current_time");
  if (result.rowCount !== 1) {
    throw new Error("Database health query returned an unexpected result");
  }
}

function connectionStringWithoutSslOverrides(connectionString: string): string {
  const url = new URL(connectionString);

  for (const parameter of [
    "sslcert",
    "sslkey",
    "sslmode",
    "sslnegotiation",
    "sslrootcert",
    "uselibpqcompat",
  ]) {
    url.searchParams.delete(parameter);
  }

  return url.toString();
}

function normalizeSha256Fingerprint(fingerprint: string): string {
  const normalized = fingerprint.trim().replaceAll(":", "").toUpperCase();
  if (!/^[A-F0-9]{64}$/.test(normalized)) {
    throw new Error("DATABASE_TLS_SHA256 must contain a valid SHA-256 certificate fingerprint");
  }
  return normalized;
}

function assertPinnedTlsCertificate(client: unknown, expectedFingerprint: string): void {
  const stream = (
    client as {
      connection?: {
        stream?: {
          encrypted?: boolean;
          getPeerCertificate?: () => { raw?: Buffer };
        };
      };
    }
  ).connection?.stream;

  if (stream?.encrypted !== true || typeof stream.getPeerCertificate !== "function") {
    throw new Error("PostgreSQL connection is not protected by TLS");
  }

  const rawCertificate = stream.getPeerCertificate().raw;
  if (rawCertificate === undefined || rawCertificate.length === 0) {
    throw new Error("PostgreSQL did not provide a TLS certificate");
  }

  const actualFingerprint = createHash("sha256").update(rawCertificate).digest("hex").toUpperCase();
  if (actualFingerprint !== expectedFingerprint) {
    throw new Error("PostgreSQL TLS certificate fingerprint does not match the configured pin");
  }
}

export * from "./planning-runtime";
