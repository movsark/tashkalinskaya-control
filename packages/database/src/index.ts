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
  return new Pool({
    application_name: options.applicationName,
    connectionString: options.connectionString,
    max: options.maxConnections ?? 10,
    ...(options.sslMode === "require" ? { ssl: { rejectUnauthorized: true } } : {}),
  });
}

export async function checkDatabase(pool: Pool): Promise<void> {
  const result = await pool.query<{ current_time: Date }>("select now() as current_time");
  if (result.rowCount !== 1) {
    throw new Error("Database health query returned an unexpected result");
  }
}
