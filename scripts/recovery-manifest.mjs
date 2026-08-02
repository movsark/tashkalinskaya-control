import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import pg from "pg";

const { Pool } = pg;
const FORMAT_VERSION = 1;

const criticalTables = [
  { name: "audit.event", projection: "row_to_json(t)::text" },
  {
    name: "system.outbox_message",
    projection:
      "json_build_object('id',id,'event_name',event_name,'aggregate_type',aggregate_type,'aggregate_id',aggregate_id,'payload',payload,'occurred_at',occurred_at,'created_at',created_at)::text",
  },
  { name: "attendance.event", projection: "row_to_json(t)::text" },
  { name: "production.batch", projection: "row_to_json(t)::text" },
  { name: "warehouse.movement_document", projection: "row_to_json(t)::text" },
  { name: "warehouse.movement", projection: "row_to_json(t)::text" },
  { name: "warehouse.inventory_submission", projection: "row_to_json(t)::text" },
  { name: "loading.loading_line_revision", projection: "row_to_json(t)::text" },
  { name: "loading.loading_line_response", projection: "row_to_json(t)::text" },
  { name: "loading.session_confirmation", projection: "row_to_json(t)::text" },
  { name: "returns.good_return_receipt", projection: "row_to_json(t)::text" },
  { name: "returns.good_return_line", projection: "row_to_json(t)::text" },
  { name: "returns.return_allocation_revision", projection: "row_to_json(t)::text" },
  { name: "spoilage.writeoff_request", projection: "row_to_json(t)::text" },
  { name: "spoilage.writeoff_decision", projection: "row_to_json(t)::text" },
];

export function digestRows(rows) {
  const hash = createHash("sha256");
  for (const row of rows) hash.update(`${row.id}\0${row.payload}\n`);
  return hash.digest("hex");
}

export function validateRecoveryManifest(value) {
  if (!value || typeof value !== "object") throw new Error("Recovery manifest must be an object");
  if (value.formatVersion !== FORMAT_VERSION) {
    throw new Error(`Unsupported recovery manifest version: ${value.formatVersion}`);
  }
  if (!Number.isInteger(value.serverVersionNumber) || value.serverVersionNumber < 100_000) {
    throw new Error("Recovery manifest has an invalid PostgreSQL version");
  }
  if (!Array.isArray(value.migrations) || !Array.isArray(value.tables)) {
    throw new Error("Recovery manifest migrations and tables are required");
  }
  for (const migration of value.migrations) {
    if (
      typeof migration?.name !== "string" ||
      typeof migration?.checksum !== "string" ||
      !/^[0-9a-f]{64}$/.test(migration.checksum)
    ) {
      throw new Error("Recovery manifest contains an invalid migration");
    }
  }
  for (const table of value.tables) {
    if (
      typeof table?.name !== "string" ||
      !Number.isInteger(table?.rowCount) ||
      table.rowCount < 0 ||
      typeof table?.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(table.sha256)
    ) {
      throw new Error("Recovery manifest contains an invalid table digest");
    }
  }
  if (!Number.isInteger(value.stockIntegrityMismatches) || value.stockIntegrityMismatches < 0) {
    throw new Error("Recovery manifest has an invalid stock integrity result");
  }
  return value;
}

export function compareRecoveryManifests(expectedValue, actualValue) {
  const expected = validateRecoveryManifest(expectedValue);
  const actual = validateRecoveryManifest(actualValue);
  const differences = [];
  if (expected.serverVersionNumber !== actual.serverVersionNumber) {
    differences.push({
      actual: actual.serverVersionNumber,
      expected: expected.serverVersionNumber,
      scope: "postgres-version",
    });
  }
  if (JSON.stringify(expected.migrations) !== JSON.stringify(actual.migrations)) {
    differences.push({ scope: "migrations" });
  }
  const actualTables = new Map(actual.tables.map((table) => [table.name, table]));
  for (const expectedTable of expected.tables) {
    const actualTable = actualTables.get(expectedTable.name);
    if (
      !actualTable ||
      actualTable.rowCount !== expectedTable.rowCount ||
      actualTable.sha256 !== expectedTable.sha256
    ) {
      differences.push({
        actualRowCount: actualTable?.rowCount,
        expectedRowCount: expectedTable.rowCount,
        scope: `table:${expectedTable.name}`,
      });
    }
  }
  for (const actualTable of actual.tables) {
    if (!expected.tables.some((table) => table.name === actualTable.name)) {
      differences.push({ scope: `unexpected-table:${actualTable.name}` });
    }
  }
  if (expected.stockIntegrityMismatches !== 0 || actual.stockIntegrityMismatches !== 0) {
    differences.push({
      actual: actual.stockIntegrityMismatches,
      expected: expected.stockIntegrityMismatches,
      scope: "stock-integrity",
    });
  }
  return differences;
}

async function captureManifest(connectionString, sslRequired, tlsFingerprintSha256) {
  const normalizedFingerprint =
    sslRequired && tlsFingerprintSha256
      ? normalizeSha256Fingerprint(tlsFingerprintSha256)
      : undefined;
  const pool = new Pool({
    application_name: "tashkalinskaya-recovery-verification",
    connectionString,
    max: 1,
    ...(sslRequired
      ? {
          ssl: { rejectUnauthorized: normalizedFingerprint === undefined },
          ...(normalizedFingerprint === undefined
            ? {}
            : {
                onConnect: (client) => {
                  assertPinnedTlsCertificate(client, normalizedFingerprint);
                },
              }),
        }
      : {}),
  });
  const client = await pool.connect();
  try {
    await client.query("begin transaction isolation level repeatable read read only");
    const versionResult = await client.query("show server_version_num");
    const migrationsResult = await client.query(
      "select name,checksum from system.schema_migration order by name",
    );
    const tables = [];
    for (const table of criticalTables) {
      const result = await client.query(
        `select id::text as id, ${table.projection} as payload from ${table.name} t order by id`,
      );
      tables.push({
        name: table.name,
        rowCount: result.rowCount ?? 0,
        sha256: digestRows(result.rows),
      });
    }
    const integrityResult = await client.query(`
      with ledger as (
        select d.warehouse_id,m.product_id,m.source_bucket as bucket,-m.quantity::bigint as quantity
          from warehouse.movement m
          join warehouse.movement_document d on d.id=m.document_id
        union all
        select d.warehouse_id,m.product_id,m.target_bucket as bucket,m.quantity::bigint as quantity
          from warehouse.movement m
          join warehouse.movement_document d on d.id=m.document_id
      ), derived as (
        select warehouse_id,product_id,bucket,sum(quantity)::bigint as quantity
          from ledger group by warehouse_id,product_id,bucket
      ), compared as (
        select coalesce(d.quantity,0) as derived_quantity,
               coalesce(b.ledger_quantity,0) as stored_ledger_quantity,
               coalesce(b.quantity,0) as stored_quantity,
               coalesce(b.integrity_status,'MISSING') as integrity_status
          from derived d
          full join warehouse.stock_balance b
            on b.warehouse_id=d.warehouse_id and b.product_id=d.product_id and b.bucket=d.bucket
      )
      select count(*)::int as mismatch_count from compared
       where derived_quantity<>stored_ledger_quantity
          or stored_quantity<>stored_ledger_quantity
          or integrity_status<>'OK'
    `);
    await client.query("commit");
    return {
      capturedAt: new Date().toISOString(),
      formatVersion: FORMAT_VERSION,
      migrations: migrationsResult.rows,
      serverVersionNumber: Number(versionResult.rows[0]?.server_version_num),
      stockIntegrityMismatches: Number(integrityResult.rows[0]?.mismatch_count),
      tables,
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

function normalizeSha256Fingerprint(fingerprint) {
  const normalized = fingerprint.trim().replaceAll(":", "").toUpperCase();
  if (!/^[A-F0-9]{64}$/.test(normalized)) {
    throw new Error(
      "RECOVERY_DATABASE_TLS_SHA256 must contain a valid SHA-256 certificate fingerprint",
    );
  }
  return normalized;
}

function assertPinnedTlsCertificate(client, expectedFingerprint) {
  const stream = client.connection?.stream;
  if (stream?.encrypted !== true || typeof stream.getPeerCertificate !== "function") {
    throw new Error("PostgreSQL recovery connection is not protected by TLS");
  }
  const rawCertificate = stream.getPeerCertificate().raw;
  if (!rawCertificate?.length) {
    throw new Error("PostgreSQL did not provide a TLS certificate during recovery verification");
  }
  const actualFingerprint = createHash("sha256").update(rawCertificate).digest("hex").toUpperCase();
  if (actualFingerprint !== expectedFingerprint) {
    throw new Error("PostgreSQL recovery TLS certificate fingerprint does not match");
  }
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main() {
  const command = process.argv[2];
  const connectionString = process.env.RECOVERY_DATABASE_URL;
  if (!connectionString) throw new Error("RECOVERY_DATABASE_URL is required");
  const sslRequired = process.env.RECOVERY_DATABASE_SSL === "require";
  const tlsFingerprintSha256 = process.env.RECOVERY_DATABASE_TLS_SHA256;

  if (command === "capture") {
    const outputPath = argument("--output");
    if (!outputPath) throw new Error("Usage: recovery-manifest.mjs capture --output <file>");
    const manifest = validateRecoveryManifest(
      await captureManifest(connectionString, sslRequired, tlsFingerprintSha256),
    );
    if (manifest.stockIntegrityMismatches !== 0) {
      throw new Error(
        `Cannot capture an inconsistent baseline: ${manifest.stockIntegrityMismatches} stock mismatches`,
      );
    }
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`Recovery manifest captured: ${outputPath}\n`);
    return;
  }

  if (command === "verify") {
    const inputPath = argument("--input");
    if (!inputPath) throw new Error("Usage: recovery-manifest.mjs verify --input <file>");
    const expected = validateRecoveryManifest(JSON.parse(await readFile(inputPath, "utf8")));
    const actual = validateRecoveryManifest(
      await captureManifest(connectionString, sslRequired, tlsFingerprintSha256),
    );
    const differences = compareRecoveryManifests(expected, actual);
    if (differences.length > 0) {
      process.stderr.write(`${JSON.stringify({ differences, passed: false }, null, 2)}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(
      `${JSON.stringify({ passed: true, tables: actual.tables.length }, null, 2)}\n`,
    );
    return;
  }

  throw new Error("Usage: recovery-manifest.mjs capture --output <file> | verify --input <file>");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Recovery verification failed"}\n`,
    );
    process.exitCode = 1;
  }
}
