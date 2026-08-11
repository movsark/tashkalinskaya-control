import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadApiConfig } from "../config";
import { DatabaseService } from "../database.service";
import type { ParsedImportRow } from "./catalog-import.parser";
import { CatalogRepository } from "./catalog.repository";

const hasDatabase = typeof process.env.DATABASE_URL === "string";
const database = new DatabaseService(loadApiConfig(process.env));
const repository = new CatalogRepository(database);
const employeeId = randomUUID();
const departmentId = randomUUID();
const correlationId = randomUUID();
const suffix = employeeId.slice(0, 8).toUpperCase();
const productCode = `B07-${suffix}`;
const departmentCode = `B07-${departmentId.slice(0, 8).toUpperCase()}`;
const barcode = `B07${employeeId.replaceAll("-", "").slice(0, 20)}`;
let batchId = "";

const productRow: ParsedImportRow = {
  entityType: "PRODUCT",
  naturalKey: productCode,
  normalized: {
    active: true,
    barcode,
    category: "Торты Базовые",
    comment: null,
    externalCode: null,
    name: "Интеграционный торт B07",
    primaryWorkshopCode: departmentCode,
    productCode,
    unit: "шт",
  },
  raw: {},
  rowKey: "Товары:4",
  sheetName: "Товары",
  sourceRowNumber: 4,
  status: "VALID",
};

const normRow: ParsedImportRow = {
  entityType: "NORM",
  naturalKey: `1|1|${productCode}|2026-08-03`,
  normalized: {
    comment: null,
    productCode,
    quantity: 12,
    territoryNumber: 1,
    validFrom: "2026-08-03",
    validUntil: null,
    weekday: 1,
  },
  raw: {},
  rowKey: "Нормы:4",
  sheetName: "Нормы",
  sourceRowNumber: 4,
  status: "VALID",
};

describe.runIf(hasDatabase)("CatalogRepository with PostgreSQL", () => {
  beforeAll(async () => {
    await database.query("insert into identity.department (id, code, name) values ($1, $2, $3)", [
      departmentId,
      departmentCode,
      `Цех B07 ${suffix}`,
    ]);
    await database.query(
      `
        insert into identity.employee (
          id, personnel_number, personnel_number_normalized, full_name, department_id
        ) values ($1, $2, $2, 'Администратор B07', $3)
      `,
      [employeeId, `B07-${employeeId}`, departmentId],
    );
  });

  afterAll(async () => {
    await database.onApplicationShutdown();
  });

  it("previews and atomically applies products before their norms", async () => {
    batchId = await repository.savePreview({
      actorEmployeeId: employeeId,
      correlationId,
      effectiveFrom: "2026-08-03",
      fileName: "B07.xlsx",
      fileSha256: "a".repeat(64),
      fileSize: 1024,
      idempotencyKey: `B07-${employeeId}`,
      issues: [],
      rows: [productRow, normRow],
      status: "READY",
    });
    await expect(repository.getImport(batchId)).resolves.toMatchObject({
      counts: { total: 2, valid: 2 },
      status: "READY",
    });

    await repository.applyImport({
      acknowledgedWarningCodes: [],
      actorEmployeeId: employeeId,
      batchId,
      correlationId,
    });

    await expect(repository.getImport(batchId)).resolves.toMatchObject({
      appliedAt: expect.any(String),
      status: "APPLIED",
    });
    const state = await database.query<{ norm_count: string; product_count: string }>(
      `
        select
          (select count(*) from catalog.product where product_code = $1)::text as product_count,
          (select count(*) from planning.weekly_norm n
            join catalog.product p on p.id = n.product_id
            where p.product_code = $1 and n.quantity = 12)::text as norm_count
      `,
      [productCode],
    );
    expect(state.rows[0]).toEqual({ norm_count: "1", product_count: "1" });
    const versions = await database.query<{ count: string }>(
      `
        select count(*)::text as count
        from catalog.product_version
        where product_id in (select id from catalog.product where product_code = $1)
      `,
      [productCode],
    );
    expect(versions.rows[0]?.count).toBe("1");
  });

  it("includes a whole-file validation issue in the preview counters", async () => {
    const invalidBatchId = await repository.savePreview({
      actorEmployeeId: employeeId,
      correlationId: randomUUID(),
      effectiveFrom: "2026-08-03",
      fileName: "empty.xlsx",
      fileSha256: "b".repeat(64),
      fileSize: 1024,
      idempotencyKey: `B07-empty-${employeeId}`,
      issues: [
        {
          code: "EMPTY_IMPORT",
          columnName: null,
          message: "В файле нет заполненных товаров или норм",
          rowKey: null,
          safeValuePreview: null,
          severity: "ERROR",
          suggestedFix: "Заполните хотя бы одну строку данных",
        },
      ],
      rows: [],
      status: "INVALID",
    });

    await expect(repository.getImport(invalidBatchId)).resolves.toMatchObject({
      counts: { errors: 1, total: 0 },
      status: "INVALID",
    });
  });

  it("optionally creates one daily norm for every active territory and future plan date", async () => {
    const targetDate = "2099-08-11";
    const references = await database.query<{ product_id: string; territory_id: string }>(
      `select p.id product_id,t.id territory_id
       from catalog.product p
       cross join logistics.territory t
       where p.product_code=$1 and t.status='ACTIVE'
       order by t.territory_number limit 1`,
      [productCode],
    );
    const reference = references.rows[0]!;
    await database.query(
      `insert into planning.territory_daily_norm (
         id,territory_id,dispatch_date,product_id,quantity,version,reason,created_by,correlation_id
       ) values ($1,$2,$3,$4,1,1,'B07 test date',$5,$6)`,
      [
        randomUUID(),
        reference.territory_id,
        targetDate,
        reference.product_id,
        employeeId,
        randomUUID(),
      ],
    );
    const activeTerritories = await database.query<{ count: number }>(
      "select count(*)::int count from logistics.territory where status='ACTIVE'",
    );

    const withNorms = await repository.createDirectProduct({
      actorEmployeeId: employeeId,
      categoryCode: "BASIC_CAKES",
      correlationId: randomUUID(),
      dailyNormQuantity: 7,
      name: `Товар со всеми нормами ${suffix}`,
    });
    const normCount = await database.query<{ count: number }>(
      `select count(*)::int count from planning.territory_daily_norm
       where product_id=$1 and dispatch_date=$2 and quantity=7 and is_current`,
      [withNorms.id, targetDate],
    );
    expect(normCount.rows[0]?.count).toBe(activeTerritories.rows[0]?.count);

    const withoutNorms = await repository.createDirectProduct({
      actorEmployeeId: employeeId,
      categoryCode: "BASIC_CAKES",
      correlationId: randomUUID(),
      name: `Товар без норм ${suffix}`,
    });
    const emptyNormCount = await database.query<{ count: number }>(
      "select count(*)::int count from planning.territory_daily_norm where product_id=$1",
      [withoutNorms.id],
    );
    expect(emptyNormCount.rows[0]?.count).toBe(0);
  });

  it("treats repeated apply as a no-op and keeps the applied batch immutable", async () => {
    await repository.applyImport({
      acknowledgedWarningCodes: [],
      actorEmployeeId: employeeId,
      batchId,
      correlationId: randomUUID(),
    });
    const counts = await database.query<{ norms: string; products: string }>(
      `
        select
          (select count(*) from catalog.product where product_code = $1)::text as products,
          (select count(*) from planning.weekly_norm n
            join catalog.product p on p.id = n.product_id
            where p.product_code = $1)::text as norms
      `,
      [productCode],
    );
    expect(counts.rows[0]).toEqual({ norms: "1", products: "1" });
    await expect(
      database.query(
        "update importing.import_batch set original_file_name = 'changed.xlsx' where id = $1",
        [batchId],
      ),
    ).rejects.toMatchObject({ code: "P0001" });
    await expect(
      database.query("delete from importing.import_row where batch_id = $1", [batchId]),
    ).rejects.toMatchObject({ code: "P0001" });
    await expect(
      database.query("delete from importing.import_batch where id = $1", [batchId]),
    ).rejects.toMatchObject({ code: "P0001" });
  });
});
