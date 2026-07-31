import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { ImportPreview } from "@tashkalinskaya/contracts";

import {
  parseCatalogImport,
  type ParsedImportIssue,
  type ParsedImportRow,
} from "./catalog-import.parser";
import type { ApplyCatalogImportDto, PreviewCatalogImportDto } from "./catalog.dto";
import { CatalogRepository, type ReferenceData } from "./catalog.repository";
import { normalizeUploadFileName } from "./catalog-upload-name";

@Injectable()
export class CatalogService {
  constructor(private readonly repository: CatalogRepository) {}

  listProducts() {
    return this.repository.listProducts();
  }

  async loadTemplate(): Promise<Buffer> {
    const relativePath = path.join("templates", "import", "Шаблон_массового_импорта.xlsx");
    const candidates = [
      path.resolve(process.cwd(), relativePath),
      path.resolve(process.cwd(), "../..", relativePath),
    ];
    for (const candidate of candidates) {
      try {
        return await readFile(candidate);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    throw new NotFoundException({
      code: "IMPORT_TEMPLATE_NOT_FOUND",
      message: "Шаблон импорта не найден на сервере",
    });
  }

  async preview(
    file: Express.Multer.File | undefined,
    dto: PreviewCatalogImportDto,
    actorEmployeeId: string,
    correlationId: string,
  ): Promise<ImportPreview> {
    if (file === undefined) {
      throw new BadRequestException({
        code: "IMPORT_FILE_REQUIRED",
        message: "Выберите файл XLSX",
      });
    }
    const fileName = normalizeUploadFileName(file.originalname);
    if (path.basename(fileName) !== fileName) {
      throw new BadRequestException({
        code: "FILE_NAME_INVALID",
        message: "Имя файла содержит запрещенный путь",
      });
    }
    const fileSha256 = createHash("sha256").update(file.buffer).digest("hex");
    const idempotencyKey = createHash("sha256")
      .update(`CATALOG_AND_NORMS|v1.0|${dto.effectiveFrom}|${fileSha256}`)
      .digest("hex");
    const existingId = await this.repository.findBatchIdByKey(idempotencyKey);
    if (existingId !== null) return this.requireImport(existingId);

    const parsed = await parseCatalogImport(file.buffer, fileName, dto.effectiveFrom);
    const issues = [...parsed.issues];
    const rows = parsed.rows.map((row) => ({ ...row }));
    const references = await this.repository.referenceData(dto.effectiveFrom);
    validateReferences(rows, issues, references);
    updateStatuses(rows, issues);
    const hasErrors =
      rows.some((row) => row.status === "ERROR") ||
      issues.some((issue) => issue.severity === "ERROR");
    const hasWarnings = issues.some((issue) => issue.severity === "WARNING");
    const status = hasErrors ? "INVALID" : hasWarnings ? "READY_WITH_WARNINGS" : "READY";
    const batchId = await this.repository.savePreview({
      actorEmployeeId,
      correlationId,
      effectiveFrom: dto.effectiveFrom,
      fileName,
      fileSha256,
      fileSize: file.size,
      idempotencyKey,
      issues,
      rows,
      status,
    });
    return this.requireImport(batchId);
  }

  async getImport(batchId: string): Promise<ImportPreview> {
    return this.requireImport(batchId);
  }

  async issueReport(batchId: string): Promise<string> {
    const preview = await this.requireImport(batchId);
    const records = [
      ["severity", "code", "sheet", "row", "column", "value", "message", "suggested_fix"],
      ...preview.issues.map((issue) => [
        issue.severity,
        issue.code,
        issue.sheetName ?? "",
        issue.sourceRowNumber?.toString() ?? "",
        issue.columnName ?? "",
        issue.safeValuePreview ?? "",
        issue.message,
        issue.suggestedFix,
      ]),
    ];
    return `\uFEFF${records.map((record) => record.map(csvCell).join(";")).join("\r\n")}\r\n`;
  }

  async apply(
    batchId: string,
    dto: ApplyCatalogImportDto,
    actorEmployeeId: string,
    correlationId: string,
  ): Promise<ImportPreview> {
    try {
      await this.repository.applyImport({
        acknowledgedWarningCodes: dto.acknowledgedWarningCodes,
        actorEmployeeId,
        batchId,
        correlationId,
      });
    } catch (error) {
      const catalogCode = readCatalogCode(error);
      if (catalogCode !== null) {
        throw new ConflictException({ code: catalogCode, message: (error as Error).message });
      }
      await this.repository.markFailed(batchId, "DATABASE_APPLY_FAILED").catch(() => undefined);
      throw error;
    }
    return this.requireImport(batchId);
  }

  private async requireImport(batchId: string): Promise<ImportPreview> {
    const preview = await this.repository.getImport(batchId);
    if (preview === null) {
      throw new NotFoundException({ code: "IMPORT_NOT_FOUND", message: "Пакет импорта не найден" });
    }
    return preview;
  }
}

function validateReferences(
  rows: ParsedImportRow[],
  issues: ParsedImportIssue[],
  references: ReferenceData,
): void {
  const productsInBatch = new Set(
    rows
      .filter(
        (row) => row.entityType === "PRODUCT" && typeof row.normalized.productCode === "string",
      )
      .map((row) => String(row.normalized.productCode)),
  );
  for (const row of rows) {
    if (row.entityType === "PRODUCT") {
      const code = stringValue(row, "productCode");
      const category = stringValue(row, "category");
      const unit = stringValue(row, "unit");
      const workshop = optionalStringValue(row, "primaryWorkshopCode");
      const barcode = optionalStringValue(row, "barcode");
      const externalCode = optionalStringValue(row, "externalCode");
      if (!references.categories.has(category)) {
        issue(
          issues,
          row,
          "ERROR",
          "CATEGORY_UNKNOWN",
          "Категория",
          category,
          "Категория отсутствует в активном справочнике",
          "Выберите категорию из листа «Справочники»",
        );
      }
      if (!references.units.has(unit)) {
        issue(
          issues,
          row,
          "ERROR",
          "UNIT_UNKNOWN",
          "Единица",
          unit,
          "Единица отсутствует в активном справочнике",
          "Выберите единицу из листа «Справочники»",
        );
      }
      if (workshop !== null && !references.workshops.has(workshop)) {
        issue(
          issues,
          row,
          "ERROR",
          "WORKSHOP_UNKNOWN",
          "Основной цех",
          workshop,
          "Код цеха не найден",
          "Укажите точный код активного цеха",
        );
      }
      const barcodeOwner = barcode === null ? undefined : references.barcodes.get(barcode);
      if (barcodeOwner !== undefined && barcodeOwner !== code) {
        issue(
          issues,
          row,
          "ERROR",
          "BARCODE_ALREADY_ASSIGNED",
          "Штрихкод",
          barcode,
          `Штрихкод уже закреплен за ${barcodeOwner}`,
          "Проверьте карточки обоих товаров",
        );
      }
      const externalOwner =
        externalCode === null ? undefined : references.externalCodes.get(externalCode);
      if (externalOwner !== undefined && externalOwner !== code) {
        issue(
          issues,
          row,
          "ERROR",
          "EXTERNAL_CODE_ALREADY_ASSIGNED",
          "Внешний код",
          externalCode,
          `Внешний код уже закреплен за ${externalOwner}`,
          "Исправьте внешний код",
        );
      }
    } else {
      const productCode = stringValue(row, "productCode");
      if (!references.productCodes.has(productCode) && !productsInBatch.has(productCode)) {
        issue(
          issues,
          row,
          "ERROR",
          "PRODUCT_UNKNOWN",
          "Код товара",
          productCode,
          "Товар не найден в справочнике и не создается этим файлом",
          "Добавьте товар на лист «Товары» или исправьте код",
        );
      }
      const key = `${numberValue(row, "territoryNumber")}|${numberValue(row, "weekday")}|${productCode}`;
      if (references.futureNormKeys.has(key)) {
        issue(
          issues,
          row,
          "ERROR",
          "FUTURE_NORM_OVERLAP",
          "Дата начала",
          stringValue(row, "validFrom"),
          "Существует утвержденная версия нормы с этой или более поздней датой",
          "Используйте отдельную административную замену версии",
        );
      }
    }
  }
}

function updateStatuses(rows: ParsedImportRow[], issues: readonly ParsedImportIssue[]): void {
  for (const row of rows) {
    if (issues.some((issue) => issue.rowKey === row.rowKey && issue.severity === "ERROR")) {
      row.status = "ERROR";
    } else if (
      row.status !== "SKIPPED_ZERO" &&
      issues.some((issue) => issue.rowKey === row.rowKey)
    ) {
      row.status = "WARNING";
    }
  }
}

function issue(
  issues: ParsedImportIssue[],
  row: ParsedImportRow,
  severity: "ERROR" | "WARNING",
  code: string,
  columnName: string,
  value: string | null,
  message: string,
  suggestedFix: string,
): void {
  issues.push({
    code,
    columnName,
    message,
    rowKey: row.rowKey,
    safeValuePreview: value === null ? null : safeSpreadsheetText(value).slice(0, 120),
    severity,
    suggestedFix,
  });
}

function stringValue(row: ParsedImportRow, key: string): string {
  const value = row.normalized[key];
  return typeof value === "string" ? value : "";
}

function optionalStringValue(row: ParsedImportRow, key: string): string | null {
  const value = row.normalized[key];
  return typeof value === "string" ? value : null;
}

function numberValue(row: ParsedImportRow, key: string): number {
  const value = row.normalized[key];
  return typeof value === "number" ? value : -1;
}

function csvCell(value: string): string {
  const safe = safeSpreadsheetText(value).replaceAll('"', '""');
  return `"${safe}"`;
}

function safeSpreadsheetText(value: string): string {
  const cleaned = [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127 ? " " : character;
    })
    .join("");
  return /^[=+\-@]/u.test(cleaned) ? `'${cleaned}` : cleaned;
}

function readCatalogCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("catalogCode" in error)) return null;
  return typeof error.catalogCode === "string" ? error.catalogCode : null;
}
