import { randomUUID } from "node:crypto";

import { Injectable } from "@nestjs/common";
import type {
  ImportIssueView,
  ImportPreview,
  ImportPreviewRow,
  ProductListResponse,
} from "@tashkalinskaya/contracts";
import type { PoolClient } from "pg";

import { DatabaseService } from "../database.service";
import type { ParsedImportIssue, ParsedImportRow } from "./catalog-import.parser";

interface BatchRow {
  readonly applied_at: Date | null;
  readonly effective_from: string;
  readonly error_rows: number;
  readonly file_sha256: string;
  readonly id: string;
  readonly original_file_name: string;
  readonly skipped_rows: number;
  readonly status: ImportPreview["status"];
  readonly template_version: "v1.0";
  readonly total_rows: number;
  readonly valid_rows: number;
  readonly warning_rows: number;
}

interface ImportRowRecord {
  readonly entity_type: "NORM" | "PRODUCT";
  readonly natural_key: string;
  readonly normalized_snapshot: Record<string, boolean | number | string | null>;
  readonly sheet_name: "Нормы" | "Товары";
  readonly source_row_number: number;
  readonly status: ImportPreviewRow["status"];
}

export interface ReferenceData {
  readonly barcodes: ReadonlyMap<string, string>;
  readonly categories: ReadonlySet<string>;
  readonly externalCodes: ReadonlyMap<string, string>;
  readonly futureNormKeys: ReadonlySet<string>;
  readonly productCodes: ReadonlySet<string>;
  readonly units: ReadonlySet<string>;
  readonly workshops: ReadonlySet<string>;
}

@Injectable()
export class CatalogRepository {
  constructor(private readonly database: DatabaseService) {}

  async findBatchIdByKey(idempotencyKey: string): Promise<string | null> {
    const result = await this.database.query<{ id: string }>(
      "select id from importing.import_batch where idempotency_key = $1",
      [idempotencyKey],
    );
    return result.rows[0]?.id ?? null;
  }

  async referenceData(effectiveFrom: string): Promise<ReferenceData> {
    const [categories, units, workshops, products, barcodes, externalCodes, futureNorms] =
      await Promise.all([
        this.database.query<{ name: string }>(
          "select name from catalog.category where status = 'ACTIVE'",
        ),
        this.database.query<{ name: string }>(
          "select name from catalog.unit where status = 'ACTIVE'",
        ),
        this.database.query<{ code: string }>(
          "select code from identity.department where status = 'ACTIVE'",
        ),
        this.database.query<{ product_code: string }>("select product_code from catalog.product"),
        this.database.query<{ barcode: string; product_code: string }>(
          `
            select pb.barcode, p.product_code
            from catalog.product_barcode pb
            join catalog.product p on p.id = pb.product_id
            where pb.status = 'ACTIVE'
          `,
        ),
        this.database.query<{ external_code: string; product_code: string }>(
          "select external_code, product_code from catalog.product where external_code is not null",
        ),
        this.database.query<{ product_code: string; territory_number: number; weekday: number }>(
          `
            select p.product_code, t.territory_number, n.weekday
            from planning.weekly_norm n
            join catalog.product p on p.id = n.product_id
            join logistics.territory t on t.id = n.territory_id
            where n.valid_from >= $1::date
          `,
          [effectiveFrom],
        ),
      ]);
    return {
      barcodes: new Map(barcodes.rows.map((row) => [row.barcode, row.product_code])),
      categories: new Set(categories.rows.map((row) => row.name)),
      externalCodes: new Map(
        externalCodes.rows.map((row) => [row.external_code, row.product_code]),
      ),
      futureNormKeys: new Set(
        futureNorms.rows.map((row) => `${row.territory_number}|${row.weekday}|${row.product_code}`),
      ),
      productCodes: new Set(products.rows.map((row) => row.product_code)),
      units: new Set(units.rows.map((row) => row.name)),
      workshops: new Set(workshops.rows.map((row) => row.code)),
    };
  }

  async savePreview(input: {
    actorEmployeeId: string;
    correlationId: string;
    effectiveFrom: string;
    fileName: string;
    fileSha256: string;
    fileSize: number;
    idempotencyKey: string;
    issues: readonly ParsedImportIssue[];
    rows: readonly ParsedImportRow[];
    status: "INVALID" | "READY" | "READY_WITH_WARNINGS";
  }): Promise<string> {
    return this.database.transaction(async (client) => {
      const batchId = randomUUID();
      const counts = countRows(input.rows, input.issues);
      const inserted = await client.query<{ id: string }>(
        `
          insert into importing.import_batch (
            id, import_type, template_version, original_file_name, file_size, file_sha256,
            effective_from, status, total_rows, valid_rows, warning_rows, error_rows,
            skipped_rows, uploaded_by, idempotency_key, correlation_id
          )
          values (
            $1, 'CATALOG_AND_NORMS', 'v1.0', $2, $3, $4, $5::date, $6,
            $7, $8, $9, $10, $11, $12, $13, $14
          )
          on conflict (idempotency_key) do nothing
          returning id
        `,
        [
          batchId,
          input.fileName,
          input.fileSize,
          input.fileSha256,
          input.effectiveFrom,
          input.status,
          counts.total,
          counts.valid,
          counts.warnings,
          counts.errors,
          counts.skipped,
          input.actorEmployeeId,
          input.idempotencyKey,
          input.correlationId,
        ],
      );
      if (inserted.rows[0] === undefined) {
        const existing = await client.query<{ id: string }>(
          "select id from importing.import_batch where idempotency_key = $1",
          [input.idempotencyKey],
        );
        const existingId = existing.rows[0]?.id;
        if (existingId === undefined) throw new Error("Idempotent import batch is missing");
        return existingId;
      }

      const rowIdByKey = new Map<string, string>();
      for (const row of input.rows) {
        const rowId = randomUUID();
        rowIdByKey.set(row.rowKey, rowId);
        await client.query(
          `
            insert into importing.import_row (
              id, batch_id, sheet_name, source_row_number, entity_type, natural_key,
              raw_snapshot, normalized_snapshot, status
            )
            values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)
          `,
          [
            rowId,
            batchId,
            row.sheetName,
            row.sourceRowNumber,
            row.entityType,
            row.naturalKey,
            JSON.stringify(row.raw),
            JSON.stringify(row.normalized),
            row.status,
          ],
        );
      }
      for (const issue of input.issues) {
        await client.query(
          `
            insert into importing.import_issue (
              id, batch_id, row_id, severity, code, column_name,
              safe_value_preview, message, suggested_fix
            )
            values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          `,
          [
            randomUUID(),
            batchId,
            issue.rowKey === null ? null : rowIdByKey.get(issue.rowKey),
            issue.severity,
            issue.code,
            issue.columnName,
            issue.safeValuePreview,
            issue.message,
            issue.suggestedFix,
          ],
        );
      }
      await client.query(
        `
          insert into audit.event (
            id, occurred_at, actor_employee_id, active_role, action, object_type,
            object_id, correlation_id, result, metadata
          )
          values ($1, now(), $2, 'ADMIN', 'IMPORT_PREVIEW_CREATED', 'IMPORT_BATCH',
            $3, $4, 'SUCCESS', jsonb_build_object('status', $5::text, 'sha256', $6::text))
        `,
        [
          randomUUID(),
          input.actorEmployeeId,
          batchId,
          input.correlationId,
          input.status,
          input.fileSha256,
        ],
      );
      return batchId;
    });
  }

  async getImport(batchId: string): Promise<ImportPreview | null> {
    const batchResult = await this.database.query<BatchRow>(
      `
        select id, original_file_name, file_sha256, template_version, effective_from::text,
          status, total_rows, valid_rows, warning_rows, error_rows, skipped_rows, applied_at
        from importing.import_batch
        where id = $1
      `,
      [batchId],
    );
    const batch = batchResult.rows[0];
    if (batch === undefined) return null;
    const [rowsResult, issuesResult] = await Promise.all([
      this.database.query<ImportRowRecord>(
        `
          select sheet_name, source_row_number, entity_type, natural_key,
            normalized_snapshot, status
          from importing.import_row
          where batch_id = $1
          order by case when sheet_name = 'Товары' then 0 else 1 end, source_row_number
          limit 500
        `,
        [batchId],
      ),
      this.database.query<{
        code: string;
        column_name: string | null;
        message: string;
        safe_value_preview: string | null;
        severity: "ERROR" | "WARNING";
        sheet_name: string | null;
        source_row_number: number | null;
        suggested_fix: string;
      }>(
        `
          select i.severity, i.code, i.column_name, i.safe_value_preview,
            i.message, i.suggested_fix, r.sheet_name, r.source_row_number
          from importing.import_issue i
          left join importing.import_row r on r.id = i.row_id
          where i.batch_id = $1
          order by case i.severity when 'ERROR' then 0 else 1 end,
            r.sheet_name nulls first, r.source_row_number nulls first, i.code
          limit 1000
        `,
        [batchId],
      ),
    ]);
    const issues: ImportIssueView[] = issuesResult.rows.map((issue) => ({
      code: issue.code,
      columnName: issue.column_name,
      message: issue.message,
      safeValuePreview: issue.safe_value_preview,
      severity: issue.severity,
      sheetName: issue.sheet_name,
      sourceRowNumber: issue.source_row_number,
      suggestedFix: issue.suggested_fix,
    }));
    return {
      appliedAt: batch.applied_at?.toISOString() ?? null,
      batchId: batch.id,
      counts: {
        errors: batch.error_rows,
        skipped: batch.skipped_rows,
        total: batch.total_rows,
        valid: batch.valid_rows,
        warnings: batch.warning_rows,
      },
      effectiveFrom: batch.effective_from,
      fileName: batch.original_file_name,
      fileSha256: batch.file_sha256,
      issues,
      rows: rowsResult.rows.map((row) => ({
        entityType: row.entity_type,
        naturalKey: row.natural_key,
        normalized: row.normalized_snapshot,
        sheetName: row.sheet_name,
        sourceRowNumber: row.source_row_number,
        status: row.status,
      })),
      status: batch.status,
      templateVersion: batch.template_version,
      warningCodes: [
        ...new Set(
          issues.filter((issue) => issue.severity === "WARNING").map((issue) => issue.code),
        ),
      ],
    };
  }

  async listProducts(): Promise<ProductListResponse> {
    const result = await this.database.query<{
      barcodes: string[];
      category: string;
      external_code: string | null;
      id: string;
      name: string;
      primary_workshop: string | null;
      product_code: string;
      status: "ACTIVE" | "ARCHIVED";
      unit: string;
      version: number;
    }>(
      `
        select p.id, p.product_code, p.name, c.name as category, u.name as unit,
          p.external_code, p.status, p.version, d.name as primary_workshop,
          coalesce(array_agg(pb.barcode order by pb.barcode)
            filter (where pb.status = 'ACTIVE'), '{}') as barcodes
        from catalog.product p
        join catalog.category c on c.id = p.category_id
        join catalog.unit u on u.code = p.unit_code
        left join identity.department d on d.id = p.primary_workshop_id
        left join catalog.product_barcode pb on pb.product_id = p.id
        group by p.id, c.name, u.name, d.name
        order by p.status, p.name
      `,
    );
    return {
      items: result.rows.map((row) => ({
        barcodes: row.barcodes,
        category: row.category,
        externalCode: row.external_code,
        id: row.id,
        name: row.name,
        primaryWorkshop: row.primary_workshop,
        productCode: row.product_code,
        status: row.status,
        unit: row.unit,
        version: row.version,
      })),
      total: result.rowCount ?? result.rows.length,
    };
  }

  async createDirectProduct(input: {
    actorEmployeeId: string;
    categoryCode: string;
    correlationId: string;
    name: string;
  }) {
    return this.database.transaction(async (client) => {
      const prefix = {
        BASIC_CAKES: "TB",
        PREMIUM_CAKES: "TP",
        PIES_AND_PASTRIES: "PI",
        DESSERTS: "DE",
        DRY_BAKERY: "SV",
      }[input.categoryCode];
      if (prefix === undefined)
        throw catalogConflict("CATEGORY_UNKNOWN", "Выберите группу продукции");
      const next = await client.query<{ product_code: string }>(
        `select product_code from catalog.product where product_code ~ $1 order by product_code desc limit 1 for update`,
        [`^${prefix}-[0-9]+$`],
      );
      const number = Number(next.rows[0]?.product_code.split("-")[1] ?? 0) + 1;
      const productCode = `${prefix}-${String(number).padStart(3, "0")}`;
      const productId = randomUUID();
      const result = await client.query<{
        category: string;
        id: string;
        name: string;
        product_code: string;
        unit: string;
        version: number;
      }>(
        `insert into catalog.product (id,product_code,name,category_id,unit_code,status)
         select $1,$2,$3,c.id,'PCS','ACTIVE' from catalog.category c where c.code=$4 and c.status='ACTIVE'
         returning id,product_code,name,(select name from catalog.category where id=category_id) category,'шт' unit,version`,
        [productId, productCode, input.name, input.categoryCode],
      );
      const product = result.rows[0];
      if (product === undefined)
        throw catalogConflict("CATEGORY_UNKNOWN", "Группа продукции недоступна");
      await client.query(
        `insert into catalog.product_version (id,product_id,version,product_code,name,category_name,unit_name,status,source_import_batch_id)
         values ($1,$2,$3,$4,$5,$6,$7,'ACTIVE',null)`,
        [
          randomUUID(),
          product.id,
          product.version,
          product.product_code,
          product.name,
          product.category,
          product.unit,
        ],
      );
      await client.query(
        `insert into audit.event (id,occurred_at,actor_employee_id,active_role,action,object_type,object_id,correlation_id,result,metadata)
         values ($1,now(),$2,'ADMIN','PRODUCT_CREATED','PRODUCT',$3,$4,'SUCCESS',jsonb_build_object('productCode',$5))`,
        [
          randomUUID(),
          input.actorEmployeeId,
          product.id,
          input.correlationId,
          product.product_code,
        ],
      );
      await client.query(
        `insert into system.outbox_message (id,event_name,aggregate_type,aggregate_id,payload,occurred_at)
         values ($1,'catalog.product.created.v1','PRODUCT',$2,jsonb_build_object('productCode',$3),now())`,
        [randomUUID(), product.id, product.product_code],
      );
      return {
        barcodes: [],
        category: product.category,
        externalCode: null,
        id: product.id,
        name: product.name,
        primaryWorkshop: null,
        productCode: product.product_code,
        status: "ACTIVE" as const,
        unit: product.unit,
        version: product.version,
      };
    });
  }

  async applyImport(input: {
    acknowledgedWarningCodes: readonly string[];
    actorEmployeeId: string;
    batchId: string;
    correlationId: string;
  }): Promise<void> {
    await this.database.transaction(async (client) => {
      const batchResult = await client.query<{
        applied_at: Date | null;
        effective_from: string;
        status: string;
      }>(
        `
          select status, effective_from::text, applied_at
          from importing.import_batch where id = $1 for update
        `,
        [input.batchId],
      );
      const batch = batchResult.rows[0];
      if (batch === undefined) throw catalogConflict("IMPORT_NOT_FOUND", "Пакет импорта не найден");
      if (batch.status === "APPLIED") return;
      if (!["READY", "READY_WITH_WARNINGS"].includes(batch.status)) {
        throw catalogConflict("IMPORT_NOT_READY", "Импорт не готов к применению");
      }
      const warnings = await client.query<{ code: string }>(
        "select distinct code from importing.import_issue where batch_id = $1 and severity = 'WARNING'",
        [input.batchId],
      );
      const acknowledged = new Set(input.acknowledgedWarningCodes);
      const missing = warnings.rows
        .map((row) => row.code)
        .filter((code) => !acknowledged.has(code));
      if (missing.length > 0) {
        throw catalogConflict(
          "WARNINGS_NOT_ACKNOWLEDGED",
          `Подтвердите предупреждения: ${missing.join(", ")}`,
        );
      }

      const rows = await client.query<{
        entity_type: "NORM" | "PRODUCT";
        id: string;
        normalized_snapshot: Record<string, boolean | number | string | null>;
        status: string;
      }>(
        `
          select id, entity_type, normalized_snapshot, status
          from importing.import_row
          where batch_id = $1 and status in ('VALID', 'WARNING')
          order by case entity_type when 'PRODUCT' then 0 else 1 end, source_row_number
        `,
        [input.batchId],
      );
      for (const row of rows.rows.filter((item) => item.entity_type === "PRODUCT")) {
        const targetId = await applyProduct(client, row.normalized_snapshot, input.batchId);
        await client.query(
          "update importing.import_row set status = 'APPLIED', target_entity_id = $2 where id = $1",
          [row.id, targetId],
        );
      }
      for (const row of rows.rows.filter((item) => item.entity_type === "NORM")) {
        const targetId = await applyNorm(client, row.normalized_snapshot, input.batchId);
        await client.query(
          "update importing.import_row set status = 'APPLIED', target_entity_id = $2 where id = $1",
          [row.id, targetId],
        );
      }
      await client.query(
        `
          update importing.import_batch
          set status = 'APPLIED', applied_at = now(), confirmed_by = $2,
            warning_acknowledgements = $3::text[], version = version + 1
          where id = $1
        `,
        [input.batchId, input.actorEmployeeId, [...acknowledged]],
      );
      await client.query(
        `
          insert into audit.event (
            id, occurred_at, actor_employee_id, active_role, action, object_type,
            object_id, correlation_id, result, metadata
          )
          values ($1, now(), $2, 'ADMIN', 'IMPORT_APPLIED', 'IMPORT_BATCH',
            $3, $4, 'SUCCESS', jsonb_build_object('warningCodes', $5::text[]))
        `,
        [
          randomUUID(),
          input.actorEmployeeId,
          input.batchId,
          input.correlationId,
          [...acknowledged],
        ],
      );
      await client.query(
        `
          insert into system.outbox_message (
            id, event_name, aggregate_type, aggregate_id, payload, occurred_at
          )
          values ($1, 'catalog.import.applied.v1', 'IMPORT_BATCH', $2,
            jsonb_build_object('batchId', $2::uuid), now())
        `,
        [randomUUID(), input.batchId],
      );
    });
  }

  async markFailed(batchId: string, failureCode: string): Promise<void> {
    await this.database.query(
      `
        update importing.import_batch
        set status = 'FAILED', failure_code = $2, version = version + 1
        where id = $1 and status in ('READY', 'READY_WITH_WARNINGS')
      `,
      [batchId, failureCode],
    );
  }
}

async function applyProduct(
  client: PoolClient,
  product: Record<string, boolean | number | string | null>,
  batchId: string,
): Promise<string> {
  const productId = randomUUID();
  const result = await client.query<{ id: string; version: number }>(
    `
      insert into catalog.product (
        id, product_code, name, category_id, unit_code, primary_workshop_id,
        external_code, status
      )
      select $1, $2, $3, c.id, u.code, d.id, $7,
        case when $8::boolean then 'ACTIVE' else 'ARCHIVED' end
      from catalog.category c
      join catalog.unit u on u.name = $5 and u.status = 'ACTIVE'
      left join identity.department d on d.code = $6 and d.status = 'ACTIVE'
      where c.name = $4 and c.status = 'ACTIVE'
      on conflict (product_code) do update set
        name = excluded.name,
        category_id = excluded.category_id,
        unit_code = excluded.unit_code,
        primary_workshop_id = excluded.primary_workshop_id,
        external_code = excluded.external_code,
        status = excluded.status,
        updated_at = now(),
        version = catalog.product.version + 1
      returning id, version
    `,
    [
      productId,
      product.productCode,
      product.name,
      product.category,
      product.unit,
      product.primaryWorkshopCode,
      product.externalCode,
      product.active,
    ],
  );
  const appliedProduct = result.rows[0];
  if (appliedProduct === undefined) throw new Error("Validated product references are missing");
  const targetId = appliedProduct.id;
  if (typeof product.barcode === "string") {
    const barcode = await client.query<{ product_id: string }>(
      `
        insert into catalog.product_barcode (id, product_id, barcode)
        values ($1, $2, $3)
        on conflict (barcode) do update set status = 'ACTIVE', archived_at = null
          where catalog.product_barcode.product_id = excluded.product_id
        returning product_id
      `,
      [randomUUID(), targetId, product.barcode],
    );
    if (barcode.rows[0]?.product_id !== targetId) {
      throw new Error("Barcode was concurrently assigned to another product");
    }
  }
  await client.query(
    `
      insert into catalog.product_version (
        id, product_id, version, product_code, name, category_name, unit_name,
        primary_workshop_code, external_code, status, source_import_batch_id
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9,
        case when $10::boolean then 'ACTIVE' else 'ARCHIVED' end, $11)
    `,
    [
      randomUUID(),
      targetId,
      appliedProduct.version,
      product.productCode,
      product.name,
      product.category,
      product.unit,
      product.primaryWorkshopCode,
      product.externalCode,
      product.active,
      batchId,
    ],
  );
  return targetId;
}

async function applyNorm(
  client: PoolClient,
  norm: Record<string, boolean | number | string | null>,
  batchId: string,
): Promise<string> {
  const futureVersion = await client.query<{ id: string }>(
    `
      select n.id
      from planning.weekly_norm n
      join logistics.territory t on t.id = n.territory_id
      join catalog.product p on p.id = n.product_id
      where t.territory_number = $1 and n.weekday = $2 and p.product_code = $3
        and n.valid_from >= $4::date
      for update
      limit 1
    `,
    [norm.territoryNumber, norm.weekday, norm.productCode, norm.validFrom],
  );
  if (futureVersion.rows[0] !== undefined) {
    throw new Error("A future norm version was concurrently created");
  }
  await client.query(
    `
      update planning.weekly_norm n
      set valid_until = $4::date - 1
      from logistics.territory t, catalog.product p
      where n.territory_id = t.id and n.product_id = p.id
        and t.territory_number = $1 and n.weekday = $2 and p.product_code = $3
        and n.valid_from < $4::date
        and (n.valid_until is null or n.valid_until >= $4::date)
    `,
    [norm.territoryNumber, norm.weekday, norm.productCode, norm.validFrom],
  );
  const id = randomUUID();
  const result = await client.query<{ id: string }>(
    `
      insert into planning.weekly_norm (
        id, territory_id, weekday, product_id, quantity,
        valid_from, valid_until, source_import_batch_id
      )
      select $1, t.id, $2, p.id, $3, $4::date, $5::date, $6
      from logistics.territory t, catalog.product p
      where t.territory_number = $7 and p.product_code = $8
      returning id
    `,
    [
      id,
      norm.weekday,
      norm.quantity,
      norm.validFrom,
      norm.validUntil,
      batchId,
      norm.territoryNumber,
      norm.productCode,
    ],
  );
  const targetId = result.rows[0]?.id;
  if (targetId === undefined) throw new Error("Validated norm references are missing");
  return targetId;
}

function countRows(rows: readonly ParsedImportRow[], issues: readonly ParsedImportIssue[]) {
  const globalErrors = issues.filter(
    (issue) => issue.rowKey === null && issue.severity === "ERROR",
  ).length;
  const globalWarnings = issues.filter(
    (issue) => issue.rowKey === null && issue.severity === "WARNING",
  ).length;
  return {
    errors: rows.filter((row) => row.status === "ERROR").length + globalErrors,
    skipped: rows.filter((row) => row.status === "SKIPPED_ZERO").length,
    total: rows.length,
    valid: rows.filter((row) => row.status === "VALID").length,
    warnings: rows.filter((row) => row.status === "WARNING").length + globalWarnings,
  };
}

function catalogConflict(code: string, message: string): Error {
  const error = new Error(message);
  Object.assign(error, { catalogCode: code });
  return error;
}
