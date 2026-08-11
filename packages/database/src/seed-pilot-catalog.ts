import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import catalogData from "./pilot-catalog.data.json";
import { createDatabasePool, isDatabaseConfigured } from "./index";

interface PilotProduct {
  readonly categoryCode: string;
  readonly name: string;
  readonly productCode: string;
}

interface ExistingProduct extends PilotProduct {
  readonly status: string;
  readonly unitCode: string;
}

export const pilotCatalog: readonly PilotProduct[] = catalogData;

export function validatePilotCatalog(products: readonly PilotProduct[]): void {
  if (products.length !== 81) throw new Error("Pilot catalog must contain exactly 81 products");

  const codes = new Set(products.map((product) => product.productCode));
  if (codes.size !== products.length) throw new Error("Pilot catalog contains duplicate codes");

  const expectedRanges = [
    ...codesInRange("TB", 19),
    ...codesInRange("TP", 16),
    ...codesInRange("PI", 9),
    ...codesInRange("DE", 10),
    ...codesInRange("SV", 27),
  ];
  if (expectedRanges.some((code) => !codes.has(code))) {
    throw new Error("Pilot catalog does not contain the approved product code ranges");
  }

  for (const product of products) {
    if (product.name.trim().length < 2)
      throw new Error(`Product ${product.productCode} has no name`);
    if (product.categoryCode.trim().length === 0) {
      throw new Error(`Product ${product.productCode} has no category`);
    }
  }
}

export async function seedPilotCatalog(client: PoolClient): Promise<"inserted" | "verified"> {
  validatePilotCatalog(pilotCatalog);
  await client.query("select pg_advisory_xact_lock($1)", [7812081]);

  const existing = await client.query<ExistingProduct>(`
    select
      p.product_code as "productCode",
      p.name,
      c.code as "categoryCode",
      p.unit_code as "unitCode",
      p.status
    from catalog.product p
    join catalog.category c on c.id = p.category_id
    order by p.product_code
  `);

  if (existing.rowCount !== 0) {
    assertExistingCatalog(existing.rows);
    return "verified";
  }

  for (const product of pilotCatalog) {
    const productId = randomUUID();
    const inserted = await client.query<{ id: string }>(
      `
        insert into catalog.product (
          id, product_code, name, category_id, unit_code, status
        )
        select $1, $2, $3, c.id, 'PCS', 'ACTIVE'
        from catalog.category c
        where c.code = $4 and c.status = 'ACTIVE'
        returning id
      `,
      [productId, product.productCode, product.name, product.categoryCode],
    );
    if (inserted.rows[0]?.id !== productId) {
      throw new Error(`Active category is missing for product ${product.productCode}`);
    }

    await client.query(
      `
        insert into catalog.product_version (
          id, product_id, version, product_code, name, category_name,
          unit_name, status, source_import_batch_id
        )
        select $1, $2, 1, $3, $4, c.name, u.name, 'ACTIVE', null
        from catalog.category c
        join catalog.unit u on u.code = 'PCS'
        where c.code = $5
      `,
      [randomUUID(), productId, product.productCode, product.name, product.categoryCode],
    );
  }

  return "inserted";
}

function assertExistingCatalog(existing: readonly ExistingProduct[]): void {
  const expected = [...pilotCatalog].sort((left, right) =>
    left.productCode.localeCompare(right.productCode),
  );
  if (existing.length !== expected.length) {
    throw new Error(
      `Existing catalog has ${existing.length} products instead of the approved 81; no data changed`,
    );
  }

  for (const [index, product] of existing.entries()) {
    const approved = expected[index];
    if (
      approved === undefined ||
      product.productCode !== approved.productCode ||
      product.name !== approved.name ||
      product.categoryCode !== approved.categoryCode ||
      product.unitCode !== "PCS" ||
      product.status !== "ACTIVE"
    ) {
      throw new Error(`Existing catalog differs at ${product.productCode}; no data changed`);
    }
  }
}

function codesInRange(prefix: string, count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `${prefix}-${String(index + 1).padStart(3, "0")}`,
  );
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!isDatabaseConfigured(connectionString)) {
    throw new Error("DATABASE_URL is required to seed the pilot catalog");
  }

  const pool = createDatabasePool({
    applicationName: "tashkalinskaya-pilot-catalog",
    connectionString,
    ...(process.env.DATABASE_NAME?.trim()
      ? { databaseName: process.env.DATABASE_NAME.trim() }
      : {}),
    maxConnections: 1,
    sslMode: process.env.DATABASE_SSL === "require" ? "require" : "disable",
  });
  const client = await pool.connect();

  try {
    await client.query("begin");
    const result = await seedPilotCatalog(client);
    await client.query("commit");
    process.stdout.write(`Pilot catalog ${result}: 81 products\n`);
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/postgres(?:ql)?:\/\/\S+/giu, "<redacted-database-url>")
    .replace(/password\s*=\s*\S+/giu, "password=<redacted>");
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    process.stdout.write(`Pilot catalog seed failed: ${safeError(error)}\n`);
    process.exitCode = 1;
  });
}
