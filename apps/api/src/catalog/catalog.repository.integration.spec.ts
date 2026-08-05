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
