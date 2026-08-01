import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { createDatabasePool, isDatabaseConfigured } from "./index";

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;

  if (!isDatabaseConfigured(connectionString)) {
    throw new Error("DATABASE_URL is required to run migrations");
  }

  const pool = createDatabasePool({
    applicationName: "tashkalinskaya-migrations",
    connectionString,
    maxConnections: 1,
    sslMode: process.env.DATABASE_SSL === "require" ? "require" : "disable",
  });

  const migrationsDirectory = path.resolve(__dirname, "../migrations");
  const migrationFiles = (await readdir(migrationsDirectory))
    .filter((fileName) => fileName.endsWith(".sql"))
    .sort();

  const client = await pool.connect();

  try {
    await client.query("select pg_advisory_lock($1)", [7812041]);
    await client.query("create schema if not exists system");
    await client.query(`
      create table if not exists system.schema_migration (
        name text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      )
    `);

    for (const fileName of migrationFiles) {
      const sql = await readFile(path.join(migrationsDirectory, fileName), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const applied = await client.query<{ checksum: string }>(
        "select checksum from system.schema_migration where name = $1",
        [fileName],
      );

      if (applied.rowCount === 1) {
        if (applied.rows[0]?.checksum !== checksum) {
          throw new Error(`Applied migration was modified: ${fileName}`);
        }
        continue;
      }

      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into system.schema_migration (name, checksum) values ($1, $2)", [
          fileName,
          checksum,
        ]);
        await client.query("commit");
        process.stdout.write(`Applied migration ${fileName}\n`);
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    }
  } finally {
    await client.query("select pg_advisory_unlock($1)", [7812041]).catch(() => undefined);
    client.release();
    await pool.end();
  }
}

function formatMigrationError(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "unknown")
      : "unknown";
  const message = error instanceof Error ? error.message : String(error);
  const redactedMessage = message
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "<redacted-database-url>")
    .replace(/password\s*=\s*\S+/gi, "password=<redacted>");

  return `Migration failed [${code}]: ${redactedMessage}`;
}

function migrationExitCode(error: unknown): number {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes("DATABASE_URL is required")) return 10;
  if (code === "ENOTFOUND") return 11;
  if (code === "ECONNREFUSED") return 12;
  if (code === "ETIMEDOUT" || code === "ETIME") return 13;
  if (
    [
      "CERT_HAS_EXPIRED",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "SELF_SIGNED_CERT_IN_CHAIN",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    ].includes(code)
  )
    return 14;
  if (code === "28P01") return 21;
  if (code === "42501") return 22;
  if (code === "3D000") return 23;
  if (code === "28000") return 24;

  return 99;
}

void main().catch((error: unknown) => {
  process.stdout.write(`${formatMigrationError(error)}\n`);
  process.exitCode = migrationExitCode(error);
});
