import { Pool } from "pg";

export interface DatabasePoolOptions {
  readonly applicationName: string;
  readonly connectionString: string;
  readonly maxConnections?: number;
  readonly sslMode?: "disable" | "require";
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

  return new Pool({
    application_name: options.applicationName,
    connectionString,
    max: options.maxConnections ?? 10,
    ...(options.sslMode === "require"
      ? {
          ssl: {
            // Timeweb Managed PostgreSQL exposes a per-cluster self-signed
            // certificate whose DNS name differs from the public endpoint.
            // NODE_EXTRA_CA_CERTS pins that exact certificate; keep chain
            // verification enabled and skip only the incompatible DNS check.
            checkServerIdentity: () => undefined,
            rejectUnauthorized: true,
          },
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

export * from "./planning-runtime";
