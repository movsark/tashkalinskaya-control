import { BadRequestException } from "@nestjs/common";
import { XMLParser } from "fast-xml-parser";
import JSZip from "jszip";

const requiredSheets = ["Инструкция", "Товары", "Нормы", "Справочники"] as const;
const productHeaders = [
  "Код товара*",
  "Наименование*",
  "Категория*",
  "Единица*",
  "Штрихкод",
  "Основной цех",
  "Активен*",
  "Внешний код",
  "Комментарий",
] as const;
const normHeaders = [
  "Территория*",
  "День вывоза*",
  "Код товара*",
  "Количество*",
  "Дата начала*",
  "Дата окончания",
  "Комментарий",
] as const;
const weekdayByName = new Map([
  ["понедельник", 1],
  ["вторник", 2],
  ["среда", 3],
  ["четверг", 4],
  ["пятница", 5],
  ["суббота", 6],
  ["воскресенье", 7],
]);
const maxFileSize = 10 * 1024 * 1024;
const maxUncompressedSize = 100 * 1024 * 1024;
const maxEntries = 500;
const maxRows = 100_000;

export interface ParsedImportIssue {
  readonly code: string;
  readonly columnName: string | null;
  readonly message: string;
  readonly rowKey: string | null;
  readonly safeValuePreview: string | null;
  readonly severity: "ERROR" | "WARNING";
  readonly suggestedFix: string;
}

export interface ParsedImportRow {
  readonly entityType: "NORM" | "PRODUCT";
  readonly naturalKey: string;
  readonly normalized: Record<string, boolean | number | string | null>;
  readonly raw: Record<string, boolean | number | string | null>;
  readonly rowKey: string;
  readonly sheetName: "Нормы" | "Товары";
  readonly sourceRowNumber: number;
  status: "ERROR" | "SKIPPED_ZERO" | "VALID" | "WARNING";
}

export interface ParsedImportWorkbook {
  readonly issues: readonly ParsedImportIssue[];
  readonly rows: readonly ParsedImportRow[];
  readonly templateVersion: "v1.0";
}

interface SheetDefinition {
  readonly name: string;
  readonly path: string;
  readonly state: string;
}

interface CellGrid {
  readonly rows: ReadonlyMap<number, ReadonlyMap<number, string | null>>;
}

const xmlParser = new XMLParser({
  attributeNamePrefix: "",
  ignoreAttributes: false,
  parseTagValue: false,
  removeNSPrefix: true,
  trimValues: false,
});

export async function parseCatalogImport(
  buffer: Buffer,
  originalFileName: string,
  requestedEffectiveFrom: string,
): Promise<ParsedImportWorkbook> {
  validateEnvelope(buffer, originalFileName, requestedEffectiveFrom);
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer, { checkCRC32: true, createFolders: false });
  } catch {
    throw fileError("XLSX_CORRUPTED", "Файл XLSX поврежден или имеет неверную структуру");
  }

  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  if (entries.length > maxEntries) {
    throw fileError("XLSX_TOO_MANY_ENTRIES", "В книге слишком много внутренних файлов");
  }
  for (const entry of entries) {
    if (
      entry.name.startsWith("/") ||
      entry.name.includes("\\") ||
      entry.name.split("/").includes("..") ||
      containsControlCharacter(entry.name)
    ) {
      throw fileError("XLSX_UNSAFE_PATH", "В книге найден небезопасный внутренний путь");
    }
    if (
      /(^|\/)(vbaProject\.bin|externalLinks|embeddings|activeX)(\/|$)/iu.test(entry.name) ||
      entry.name.endsWith(".bin")
    ) {
      throw fileError("XLSX_ACTIVE_CONTENT", "Макросы, вложения и внешние связи запрещены");
    }
  }

  const textEntries = new Map<string, string>();
  let uncompressedSize = 0;
  for (const entry of entries) {
    const declaredSize = (entry as unknown as { _data?: { uncompressedSize?: number } })._data
      ?.uncompressedSize;
    if (declaredSize !== undefined && declaredSize > maxUncompressedSize - uncompressedSize) {
      throw fileError("XLSX_UNPACKED_TOO_LARGE", "Распакованная книга превышает безопасный лимит");
    }
    const content = await entry.async("nodebuffer");
    uncompressedSize += content.byteLength;
    if (uncompressedSize > maxUncompressedSize) {
      throw fileError("XLSX_UNPACKED_TOO_LARGE", "Распакованная книга превышает безопасный лимит");
    }
    if (entry.name.endsWith(".xml") || entry.name.endsWith(".rels")) {
      const text = content.toString("utf8");
      if (/<(?:[A-Za-z0-9_]+:)?f(?:\s|>)/u.test(text)) {
        throw fileError("FORMULA_NOT_ALLOWED", "Формулы в импортируемой книге запрещены");
      }
      textEntries.set(entry.name, text);
    }
  }

  const contentTypes = requireXml(textEntries, "[Content_Types].xml");
  if (/macroEnabled|vbaProject|application\/vnd\.ms-office/iu.test(contentTypes)) {
    throw fileError("XLSX_ACTIVE_CONTENT", "Книга с макросами или активным содержимым запрещена");
  }

  const sheets = parseSheetDefinitions(textEntries);
  const sheetNames = sheets.map((sheet) => sheet.name);
  if (
    sheetNames.length !== requiredSheets.length ||
    requiredSheets.some((name) => !sheetNames.includes(name))
  ) {
    throw fileError("INVALID_SHEET_SET", `Ожидаются только листы: ${requiredSheets.join(", ")}`);
  }
  if (sheets.some((sheet) => sheet.state !== "visible")) {
    throw fileError("HIDDEN_SHEET_NOT_ALLOWED", "Скрытые листы в импортируемой книге запрещены");
  }

  const sharedStrings = parseSharedStrings(textEntries.get("xl/sharedStrings.xml"));
  const grids = new Map<string, CellGrid>();
  for (const sheet of sheets) {
    grids.set(sheet.name, parseSheet(requireXml(textEntries, sheet.path), sharedStrings));
  }

  const version = cell(grids.get("Инструкция"), 4, 2);
  if (version !== "v1.0") {
    throw fileError("UNSUPPORTED_TEMPLATE_VERSION", "Поддерживается только версия шаблона v1.0");
  }
  assertHeaders(grids.get("Товары"), productHeaders, "Товары");
  assertHeaders(grids.get("Нормы"), normHeaders, "Нормы");

  const issues: ParsedImportIssue[] = [];
  const rows = [
    ...parseProductRows(grids.get("Товары"), issues),
    ...parseNormRows(grids.get("Нормы"), requestedEffectiveFrom, issues),
  ];
  if (rows.length === 0) {
    addIssue(
      issues,
      null,
      "ERROR",
      "EMPTY_IMPORT",
      null,
      null,
      "В файле нет заполненных товаров или норм",
      "Заполните хотя бы одну строку данных",
    );
  }
  if (rows.length > maxRows) {
    throw fileError("ROW_LIMIT_EXCEEDED", `Число заполненных строк превышает лимит ${maxRows}`);
  }
  addDuplicateIssues(rows, issues);
  finalizeRowStatuses(rows, issues);

  return { issues, rows, templateVersion: "v1.0" };
}

function validateEnvelope(buffer: Buffer, fileName: string, effectiveFrom: string): void {
  if (buffer.byteLength === 0 || buffer.byteLength > maxFileSize) {
    throw fileError("FILE_SIZE_INVALID", "Размер файла должен быть от 1 байта до 10 МБ");
  }
  if (!fileName.toLowerCase().endsWith(".xlsx") || fileName.toLowerCase().endsWith(".xlsm")) {
    throw fileError("FILE_TYPE_INVALID", "Разрешены только файлы .xlsx без макросов");
  }
  if (containsControlCharacter(fileName) || fileName.includes("/") || fileName.includes("\\")) {
    throw fileError("FILE_NAME_INVALID", "Имя файла содержит запрещенные символы");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(effectiveFrom) || !isIsoDate(effectiveFrom)) {
    throw fileError(
      "EFFECTIVE_DATE_INVALID",
      "Дата начала должна быть календарной датой ГГГГ-ММ-ДД",
    );
  }
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw fileError("FILE_SIGNATURE_INVALID", "Содержимое файла не является XLSX");
  }
}

function parseSheetDefinitions(entries: ReadonlyMap<string, string>): SheetDefinition[] {
  const workbook = parseXml(requireXml(entries, "xl/workbook.xml"));
  const relationships = parseXml(requireXml(entries, "xl/_rels/workbook.xml.rels"));
  const relationList = asArray(child(child(relationships, "Relationships"), "Relationship"));
  const pathById = new Map<string, string>();
  for (const relation of relationList) {
    if (typeof relation.Id !== "string" || typeof relation.Target !== "string") continue;
    const target = relation.Target.replace(/^\//u, "");
    pathById.set(relation.Id, target.startsWith("xl/") ? target : `xl/${target}`);
  }
  return asArray(child(child(child(workbook, "workbook"), "sheets"), "sheet")).map((sheet) => {
    const name = String(sheet.name ?? "");
    const relationId = String(sheet.id ?? "");
    const path = pathById.get(relationId);
    if (path === undefined) throw fileError("XLSX_RELATION_MISSING", `Не найден XML листа ${name}`);
    return { name, path, state: String(sheet.state ?? "visible") };
  });
}

function parseSharedStrings(xml: string | undefined): string[] {
  if (xml === undefined) return [];
  const parsed = parseXml(xml);
  return asArray(child(child(parsed, "sst"), "si")).map((item) => collectText(item));
}

function parseSheet(xml: string, sharedStrings: readonly string[]): CellGrid {
  const parsed = parseXml(xml);
  const rows = new Map<number, ReadonlyMap<number, string | null>>();
  for (const row of asArray(child(child(child(parsed, "worksheet"), "sheetData"), "row"))) {
    const rowNumber = Number(row.r);
    if (!Number.isInteger(rowNumber)) continue;
    const cells = new Map<number, string | null>();
    for (const current of asArray(row.c)) {
      const reference = String(current.r ?? "");
      const column = columnNumber(reference);
      if (column === null) continue;
      const raw = current.v;
      let value: string | null = raw === undefined ? null : String(raw);
      if (current.t === "s" && value !== null) value = sharedStrings[Number(value)] ?? null;
      if (current.t === "inlineStr") value = collectText(current.is);
      cells.set(column, value);
    }
    rows.set(rowNumber, cells);
  }
  return { rows };
}

function parseProductRows(
  grid: CellGrid | undefined,
  issues: ParsedImportIssue[],
): ParsedImportRow[] {
  const result: ParsedImportRow[] = [];
  for (const [rowNumber, cells] of grid?.rows ?? []) {
    if (rowNumber < 4) continue;
    const values = Array.from({ length: productHeaders.length }, (_, index) =>
      normalizeCell(cells.get(index + 1)),
    );
    if (values.every((value) => value === null)) continue;
    const rowKey = `Товары:${rowNumber}`;
    const rawCode = values[0] ?? null;
    const name = values[1] ?? null;
    const category = values[2] ?? null;
    const unit = values[3] ?? null;
    const barcode = values[4] ?? null;
    const workshop = values[5] ?? null;
    const activeText = values[6] ?? null;
    const externalCode = values[7] ?? null;
    const comment = values[8] ?? null;
    const code = rawCode?.toUpperCase() ?? "";
    const active = parseActive(activeText);
    required(code, rowKey, "Код товара", issues);
    required(name, rowKey, "Наименование", issues);
    required(category, rowKey, "Категория", issues);
    required(unit, rowKey, "Единица", issues);
    required(activeText, rowKey, "Активен", issues);
    if (code !== "" && !/^[A-Z0-9][A-Z0-9._-]{1,39}$/u.test(code)) {
      addIssue(
        issues,
        rowKey,
        "ERROR",
        "PRODUCT_CODE_INVALID",
        "Код товара",
        rawCode,
        "Код товара должен состоять из латинских заглавных букв, цифр, точки, дефиса или подчеркивания",
        "Исправьте код, например TKF-00001",
      );
    }
    if (active === null && activeText !== null) {
      addIssue(
        issues,
        rowKey,
        "ERROR",
        "BOOLEAN_INVALID",
        "Активен",
        activeText,
        "В поле «Активен» допустимы только Да или Нет",
        "Выберите значение из списка шаблона",
      );
    }
    if (barcode === null) {
      addIssue(
        issues,
        rowKey,
        "WARNING",
        "BARCODE_MISSING",
        "Штрихкод",
        null,
        "Товар будет создан без штрихкода",
        "Добавьте штрихкод до использования сканирования",
      );
    } else if (/^\d{8}$|^\d{13}$|^\d{14}$/u.test(barcode) && !hasValidGtinCheckDigit(barcode)) {
      addIssue(
        issues,
        rowKey,
        "ERROR",
        "BARCODE_CHECK_DIGIT_INVALID",
        "Штрихкод",
        barcode,
        "Контрольная цифра EAN/GTIN неверна",
        "Проверьте штрихкод на упаковке",
      );
    } else if (!/^\d{8}$|^\d{13}$|^\d{14}$/u.test(barcode)) {
      addIssue(
        issues,
        rowKey,
        "WARNING",
        "BARCODE_NON_STANDARD",
        "Штрихкод",
        barcode,
        "Штрихкод имеет нестандартный формат",
        "Проверьте сканирование на фактическом оборудовании",
      );
    }
    if (workshop === null) {
      addIssue(
        issues,
        rowKey,
        "WARNING",
        "WORKSHOP_MISSING",
        "Основной цех",
        null,
        "Основной цех не указан",
        "Назначьте основной цех до формирования производственного плана",
      );
    }
    result.push({
      entityType: "PRODUCT",
      naturalKey: code,
      normalized: {
        active: active ?? false,
        barcode,
        category,
        comment,
        externalCode,
        name,
        primaryWorkshopCode: workshop,
        productCode: code,
        unit,
      },
      raw: {
        active: activeText,
        barcode,
        category,
        comment,
        externalCode,
        name,
        primaryWorkshopCode: workshop,
        productCode: rawCode,
        unit,
      },
      rowKey,
      sheetName: "Товары",
      sourceRowNumber: rowNumber,
      status: "VALID",
    });
  }
  return result;
}

function parseNormRows(
  grid: CellGrid | undefined,
  requestedEffectiveFrom: string,
  issues: ParsedImportIssue[],
): ParsedImportRow[] {
  const result: ParsedImportRow[] = [];
  for (const [rowNumber, cells] of grid?.rows ?? []) {
    if (rowNumber < 4) continue;
    const values = Array.from({ length: normHeaders.length }, (_, index) =>
      normalizeCell(cells.get(index + 1)),
    );
    if (values.every((value) => value === null)) continue;
    const rowKey = `Нормы:${rowNumber}`;
    const territoryText = values[0] ?? null;
    const weekdayText = values[1] ?? null;
    const rawCode = values[2] ?? null;
    const quantityText = values[3] ?? null;
    const startText = values[4] ?? null;
    const endText = values[5] ?? null;
    const comment = values[6] ?? null;
    const territory = parseInteger(territoryText);
    const weekday =
      weekdayText === null ? null : (weekdayByName.get(weekdayText.toLowerCase()) ?? null);
    const code = rawCode?.toUpperCase() ?? "";
    const quantity = parseInteger(quantityText);
    const validFrom = parseExcelDate(startText);
    const validUntil = parseExcelDate(endText);
    required(territoryText, rowKey, "Территория", issues);
    required(weekdayText, rowKey, "День вывоза", issues);
    required(code, rowKey, "Код товара", issues);
    required(quantityText, rowKey, "Количество", issues);
    required(startText, rowKey, "Дата начала", issues);
    if (territoryText !== null && (territory === null || territory < 1 || territory > 9)) {
      addIssue(
        issues,
        rowKey,
        "ERROR",
        "TERRITORY_INVALID",
        "Территория",
        territoryText,
        "Территория должна быть целым числом от 1 до 9",
        "Выберите территорию из справочника",
      );
    }
    if (weekdayText !== null && weekday === null) {
      addIssue(
        issues,
        rowKey,
        "ERROR",
        "WEEKDAY_INVALID",
        "День вывоза",
        weekdayText,
        "День вывоза отсутствует в справочнике",
        "Выберите день из списка шаблона",
      );
    }
    if (code !== "" && !/^[A-Z0-9][A-Z0-9._-]{1,39}$/u.test(code)) {
      addIssue(
        issues,
        rowKey,
        "ERROR",
        "PRODUCT_CODE_INVALID",
        "Код товара",
        rawCode,
        "Код товара имеет неверный формат",
        "Используйте утвержденный код товара",
      );
    }
    if (quantityText !== null && (quantity === null || quantity < 0 || quantity > 100_000)) {
      addIssue(
        issues,
        rowKey,
        "ERROR",
        "QUANTITY_INVALID",
        "Количество",
        quantityText,
        "Количество должно быть целым числом от 0 до 100000",
        "Исправьте количество",
      );
    }
    if (startText !== null && validFrom === null) {
      addIssue(
        issues,
        rowKey,
        "ERROR",
        "DATE_INVALID",
        "Дата начала",
        startText,
        "Дата начала не распознана",
        "Введите календарную дату",
      );
    } else if (validFrom !== null && validFrom !== requestedEffectiveFrom) {
      addIssue(
        issues,
        rowKey,
        "ERROR",
        "EFFECTIVE_DATE_MISMATCH",
        "Дата начала",
        validFrom,
        "Дата строки не совпадает с датой выбранной для загрузки",
        `Укажите ${requestedEffectiveFrom}`,
      );
    }
    if (endText !== null && validUntil === null) {
      addIssue(
        issues,
        rowKey,
        "ERROR",
        "DATE_INVALID",
        "Дата окончания",
        endText,
        "Дата окончания не распознана",
        "Введите календарную дату или оставьте поле пустым",
      );
    } else if (validFrom !== null && validUntil !== null && validUntil < validFrom) {
      addIssue(
        issues,
        rowKey,
        "ERROR",
        "DATE_RANGE_INVALID",
        "Дата окончания",
        validUntil,
        "Дата окончания раньше даты начала",
        "Исправьте период действия",
      );
    }
    if (weekday === 5 && territory !== 9) {
      addIssue(
        issues,
        rowKey,
        "WARNING",
        "UNEXPECTED_FRIDAY_NORM",
        "День вывоза",
        weekdayText,
        "Пятничная норма вне территории 9 требует подтверждения",
        "Проверьте праздничное или внеплановое исключение",
      );
    }
    result.push({
      entityType: "NORM",
      naturalKey: `${territory ?? "?"}|${weekday ?? "?"}|${code}|${validFrom ?? "?"}`,
      normalized: {
        comment,
        productCode: code,
        quantity: quantity ?? -1,
        territoryNumber: territory ?? -1,
        validFrom,
        validUntil,
        weekday: weekday ?? -1,
      },
      raw: {
        comment,
        productCode: rawCode,
        quantity: quantityText,
        territoryNumber: territoryText,
        validFrom: startText,
        validUntil: endText,
        weekday: weekdayText,
      },
      rowKey,
      sheetName: "Нормы",
      sourceRowNumber: rowNumber,
      status: quantity === 0 ? "SKIPPED_ZERO" : "VALID",
    });
  }
  return result;
}

function addDuplicateIssues(rows: readonly ParsedImportRow[], issues: ParsedImportIssue[]): void {
  const byEntityAndKey = new Map<string, ParsedImportRow[]>();
  const byBarcode = new Map<string, ParsedImportRow[]>();
  for (const row of rows) {
    const key = `${row.entityType}:${row.naturalKey}`;
    byEntityAndKey.set(key, [...(byEntityAndKey.get(key) ?? []), row]);
    if (row.entityType === "PRODUCT") {
      const barcode = row.normalized.barcode;
      if (typeof barcode === "string") {
        byBarcode.set(barcode, [...(byBarcode.get(barcode) ?? []), row]);
      }
    }
  }
  for (const duplicateRows of byEntityAndKey.values()) {
    if (duplicateRows.length < 2 || duplicateRows[0]?.naturalKey === "") continue;
    for (const row of duplicateRows) {
      addIssue(
        issues,
        row.rowKey,
        "ERROR",
        "DUPLICATE_NATURAL_KEY",
        null,
        row.naturalKey,
        "Ключ строки повторяется в этом файле",
        "Оставьте одну строку для каждого уникального ключа",
      );
    }
  }
  for (const [barcode, duplicateRows] of byBarcode) {
    if (duplicateRows.length < 2) continue;
    for (const row of duplicateRows) {
      addIssue(
        issues,
        row.rowKey,
        "ERROR",
        "DUPLICATE_BARCODE",
        "Штрихкод",
        barcode,
        "Штрихкод повторяется у нескольких товаров",
        "Исправьте штрихкод в указанных строках",
      );
    }
  }
}

function finalizeRowStatuses(rows: ParsedImportRow[], issues: readonly ParsedImportIssue[]): void {
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

function assertHeaders(
  grid: CellGrid | undefined,
  expected: readonly string[],
  sheetName: string,
): void {
  const actual = expected.map((_header, index) => cell(grid, 3, index + 1));
  if (expected.some((header, index) => actual[index] !== header)) {
    throw fileError(
      "INVALID_HEADERS",
      `Заголовки листа «${sheetName}» не соответствуют шаблону v1.0`,
    );
  }
}

function required(
  value: string | null,
  rowKey: string,
  column: string,
  issues: ParsedImportIssue[],
): void {
  if (value === null || value === "") {
    addIssue(
      issues,
      rowKey,
      "ERROR",
      "REQUIRED_VALUE",
      column,
      null,
      `Поле «${column}» обязательно`,
      "Заполните поле; пустое значение не считается нулем",
    );
  }
}

function addIssue(
  issues: ParsedImportIssue[],
  rowKey: string | null,
  severity: "ERROR" | "WARNING",
  code: string,
  columnName: string | null,
  value: string | null,
  message: string,
  suggestedFix: string,
): void {
  issues.push({
    code,
    columnName,
    message,
    rowKey,
    safeValuePreview: safePreview(value),
    severity,
    suggestedFix,
  });
}

function safePreview(value: string | null): string | null {
  if (value === null) return null;
  const normalized = stripControlCharacters(value).slice(0, 120);
  return /^[=+\-@]/u.test(normalized) ? `'${normalized}` : normalized;
}

function hasValidGtinCheckDigit(value: string): boolean {
  const digits = [...value].map(Number);
  const check = digits.pop();
  if (check === undefined) return false;
  const sum = digits
    .reverse()
    .reduce((total, digit, index) => total + digit * (index % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

function parseActive(value: string | null): boolean | null {
  if (value === null) return null;
  const normalized = value.toLowerCase();
  if (normalized === "да") return true;
  if (normalized === "нет") return false;
  return null;
}

function parseInteger(value: string | null): number | null {
  if (value === null || !/^-?\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseExcelDate(value: string | null): string | null {
  if (value === null) return null;
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return isIsoDate(value) ? value : null;
  const serial = Number(value);
  if (!Number.isFinite(serial) || serial < 1 || serial > 2_958_465) return null;
  const milliseconds = Date.UTC(1899, 11, 30) + Math.round(serial) * 86_400_000;
  return new Date(milliseconds).toISOString().slice(0, 10);
}

function isIsoDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function normalizeCell(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalized = value.trim();
  return normalized === "" ? null : normalized;
}

function cell(grid: CellGrid | undefined, row: number, column: number): string | null {
  return normalizeCell(grid?.rows.get(row)?.get(column));
}

function columnNumber(reference: string): number | null {
  const match = /^([A-Z]+)\d+$/u.exec(reference);
  if (match?.[1] === undefined) return null;
  return [...match[1]].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0);
}

function collectText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(collectText).join("");
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.t !== undefined) return collectText(record.t);
    if (record.r !== undefined) return collectText(record.r);
  }
  return "";
}

function asArray(value: unknown): Array<Record<string, unknown>> {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value]).filter(
    (item): item is Record<string, unknown> => typeof item === "object" && item !== null,
  );
}

function child(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>)[key];
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function stripControlCharacters(value: string): string {
  return [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127 ? " " : character;
    })
    .join("");
}

function parseXml(xml: string): Record<string, unknown> {
  try {
    return xmlParser.parse(xml) as Record<string, unknown>;
  } catch {
    throw fileError("XLSX_XML_INVALID", "Внутренняя XML-структура книги повреждена");
  }
}

function requireXml(entries: ReadonlyMap<string, string>, path: string): string {
  const value = entries.get(path);
  if (value === undefined) throw fileError("XLSX_PART_MISSING", `В книге отсутствует ${path}`);
  return value;
}

function fileError(code: string, message: string): BadRequestException {
  return new BadRequestException({ code, message });
}
