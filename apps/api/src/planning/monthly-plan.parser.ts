import { BadRequestException } from "@nestjs/common";
import { XMLParser } from "fast-xml-parser";
import JSZip from "jszip";

export interface MonthlyPlanRow {
  readonly dispatchDate: string;
  readonly productName: string;
  readonly quantity: number;
  readonly sheetName: string;
  readonly sourceCells: string;
  readonly territoryNumber: number;
}

export interface MonthlyPlanRounding {
  readonly from: number;
  readonly productName: string;
  readonly sheetName: string;
  readonly sourceCells: string;
  readonly territoryNumber: number;
  readonly to: number;
}

export interface ParsedMonthlyPlan {
  readonly roundings: readonly MonthlyPlanRounding[];
  readonly rows: readonly MonthlyPlanRow[];
}

const xml = new XMLParser({
  attributeNamePrefix: "",
  ignoreAttributes: false,
  parseTagValue: false,
  removeNSPrefix: true,
  trimValues: false,
});
const maxFileSize = 20 * 1024 * 1024;
const maxEntries = 2_000;
const maxUncompressedSize = 150 * 1024 * 1024;
const dailySheetName = /^\d{2}\.\d{2}\s+/u;
const territoryHeader = /^Территория\s+([1-9])\s+-.*?(\d{2}\.\d{2}\.\d{4})/iu;
const territoryLabel = /^Территория\s+[1-9]\s*-/iu;
const numericProductName = /^[+-]?\d+(?:[.,]\d+)?$/u;

interface SheetDefinition {
  readonly name: string;
  readonly path: string;
  readonly state: string;
}

type Row = ReadonlyMap<number, string | null>;
type Header = { date: string; row: number; territory: number };

interface PreparedSheet {
  readonly definition: SheetDefinition;
  readonly grid: ReadonlyMap<number, Row>;
  readonly headers: readonly Header[];
}

export async function parseMonthlyPlan(
  buffer: Buffer,
  fileName: string,
): Promise<ParsedMonthlyPlan> {
  if (buffer.byteLength === 0 || buffer.byteLength > maxFileSize) {
    throw invalid("Размер файла должен быть от 1 байта до 20 МБ");
  }
  if (!fileName.toLowerCase().endsWith(".xlsx") || fileName.toLowerCase().endsWith(".xlsm")) {
    throw invalid("Разрешены только файлы .xlsx без макросов");
  }
  let archive: JSZip;
  try {
    archive = await JSZip.loadAsync(buffer, { checkCRC32: true, createFolders: false });
  } catch {
    throw invalid("Файл XLSX поврежден или имеет неверную структуру");
  }
  const entries = Object.values(archive.files).filter((entry) => !entry.dir);
  if (entries.length > maxEntries) throw invalid("В книге слишком много внутренних файлов");
  const texts = new Map<string, string>();
  let total = 0;
  for (const entry of entries) {
    if (
      entry.name.startsWith("/") ||
      entry.name.includes("\\") ||
      entry.name.split("/").includes("..")
    ) {
      throw invalid("В книге найден небезопасный внутренний путь");
    }
    if (/(^|\/)(vbaProject\.bin|externalLinks|embeddings|activeX)(\/|$)/iu.test(entry.name)) {
      throw invalid("Макросы, вложения и внешние ссылки запрещены");
    }
    const content = await entry.async("nodebuffer");
    total += content.byteLength;
    if (total > maxUncompressedSize) throw invalid("Распакованная книга слишком велика");
    if (entry.name.endsWith(".xml") || entry.name.endsWith(".rels"))
      texts.set(entry.name, content.toString("utf8"));
  }
  if (
    /macroEnabled|vbaProject|application\/vnd\.ms-office/iu.test(
      required(texts, "[Content_Types].xml"),
    )
  ) {
    throw invalid("Книга с макросами или активным содержимым запрещена");
  }
  const shared = sharedStrings(texts.get("xl/sharedStrings.xml"));
  const sheets = definitions(texts).filter((sheet) => dailySheetName.test(sheet.name));
  if (sheets.length === 0) throw invalid("Не найдены листы с датами вывоза, например «01.08 Сб»");
  if (sheets.some((sheet) => sheet.state !== "visible"))
    throw invalid("Скрытые дневные листы не поддерживаются");
  const prepared: PreparedSheet[] = sheets.map((definition) => {
    const grid = rowsFromXml(required(texts, definition.path), shared);
    return { definition, grid, headers: findHeaders(grid) };
  });
  const reference = prepared.find((sheet) => sheet.headers.length === 9);
  if (reference === undefined)
    throw invalid("Не найден дневной лист с полным набором из 9 территорий");
  const canonicalNames = productNamesByOffset(reference);
  const rows: MonthlyPlanRow[] = [];
  const roundings: MonthlyPlanRounding[] = [];
  for (const sheet of prepared) {
    let headers = [...sheet.headers];
    let recoverNamesFromLayout = false;
    if (headers.length !== 9) {
      const first = headers.find((header) => header.territory === 1) ?? headers[0];
      const date = first?.date;
      const starts = [first?.row ?? 1, 54, 107, 160, 213, 266, 319, 372, 425];
      if (date !== undefined && headers.length >= 2) {
        headers = starts.map((row, index) => ({ date, row, territory: index + 1 }));
        recoverNamesFromLayout = true;
      } else throw invalid(`На листе «${sheet.definition.name}» ожидаются 9 территорий`);
    }
    for (let index = 0; index < headers.length; index += 1) {
      const header = headers[index];
      if (header === undefined) continue;
      const lastRow = headers[index + 1]?.row ?? Number.MAX_SAFE_INTEGER;
      for (const [rowNumber, row] of sheet.grid) {
        if (rowNumber <= header.row || rowNumber >= lastRow) continue;
        const offset = rowNumber - header.row;
        addProduct(
          rows,
          roundings,
          sheet.definition.name,
          header,
          recoverNamesFromLayout
            ? (canonicalNames.get(`1:${offset}`) ?? null)
            : (row.get(1) ?? null),
          row.get(2) ?? null,
          `A${rowNumber}:B${rowNumber}`,
        );
        addProduct(
          rows,
          roundings,
          sheet.definition.name,
          header,
          recoverNamesFromLayout
            ? (canonicalNames.get(`4:${offset}`) ?? null)
            : (row.get(4) ?? null),
          row.get(5) ?? null,
          `D${rowNumber}:E${rowNumber}`,
        );
      }
    }
  }
  if (rows.length === 0)
    throw invalid("В дневных листах не найдено ни одной строки с плановым количеством");
  assertNoDuplicateProducts(rows);
  return { rows, roundings };
}

function findHeaders(grid: ReadonlyMap<number, Row>): Header[] {
  const headers: Header[] = [];
  for (const [rowNumber, row] of grid) {
    const match = (row.get(1) ?? "").trim().match(territoryHeader);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      headers.push({ date: toIso(match[2]), row: rowNumber, territory: Number(match[1]) });
    }
  }
  return headers;
}

function productNamesByOffset(sheet: PreparedSheet): ReadonlyMap<string, string | null> {
  const first = sheet.headers.find((header) => header.territory === 1);
  const second = sheet.headers.find((header) => header.territory === 2);
  if (first === undefined || second === undefined)
    throw invalid(`На листе «${sheet.definition.name}» не найден эталон структуры товаров`);
  const names = new Map<string, string | null>();
  for (const [rowNumber, row] of sheet.grid) {
    if (rowNumber <= first.row || rowNumber >= second.row) continue;
    const offset = rowNumber - first.row;
    names.set(`1:${offset}`, row.get(1) ?? null);
    names.set(`4:${offset}`, row.get(4) ?? null);
  }
  return names;
}

function assertNoDuplicateProducts(rows: readonly MonthlyPlanRow[]): void {
  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.dispatchDate}:${row.territoryNumber}:${row.productName}`;
    if (seen.has(key)) {
      throw invalid(
        `На листе «${row.sheetName}» товар «${row.productName}» повторяется в территории ${row.territoryNumber}`,
      );
    }
    seen.add(key);
  }
}

function addProduct(
  rows: MonthlyPlanRow[],
  roundings: MonthlyPlanRounding[],
  sheetName: string,
  header: { date: string; territory: number },
  rawName: string | null,
  rawQuantity: string | null,
  sourceCells: string,
) {
  const productName = rawName?.trim().replace(/\s+/gu, " ") ?? "";
  const quantity = rawQuantity === null ? Number.NaN : Number(rawQuantity.replace(",", "."));
  if (
    productName === "" ||
    territoryLabel.test(productName) ||
    numericProductName.test(productName) ||
    ["ИТОГО", "Торты Базовые", "Торты Премиум", "Пироги", "Десерты", "Сухая выпечка"].includes(
      productName,
    ) ||
    !Number.isFinite(quantity) ||
    quantity < 0
  )
    return;
  const rounded = Math.floor(quantity + 0.5);
  if (rounded === 0) return;
  const row = {
    dispatchDate: header.date,
    productName,
    quantity: rounded,
    sheetName,
    sourceCells,
    territoryNumber: header.territory,
  };
  rows.push(row);
  if (rounded !== quantity) roundings.push({ ...row, from: quantity, to: rounded });
}

function definitions(texts: ReadonlyMap<string, string>): SheetDefinition[] {
  const workbook = xml.parse(required(texts, "xl/workbook.xml"));
  const rels = xml.parse(required(texts, "xl/_rels/workbook.xml.rels"));
  const targets = new Map(
    asArray(rels.Relationships?.Relationship).map((r) => [
      String(r.Id),
      `xl/${String(r.Target).replace(/^\//u, "").replace(/^xl\//u, "")}`,
    ]),
  );
  return asArray(workbook.workbook?.sheets?.sheet).map((sheet) => ({
    name: String(sheet.name ?? ""),
    path: targets.get(String(sheet.id)) ?? "",
    state: String(sheet.state ?? "visible"),
  }));
}

function rowsFromXml(source: string, strings: readonly string[]): Map<number, Row> {
  const worksheet = xml.parse(source).worksheet;
  const result = new Map<number, Row>();
  for (const sourceRow of asArray(worksheet?.sheetData?.row)) {
    const values = new Map<number, string | null>();
    for (const cell of asArray(sourceRow.c)) {
      const ref = String(cell.r ?? "");
      const column = columnNumber(ref);
      if (column === null) continue;
      let value = cell.v === undefined ? null : String(cell.v);
      if (cell.t === "s" && value !== null) value = strings[Number(value)] ?? null;
      if (cell.t === "inlineStr") value = textOf(cell.is);
      values.set(column, value);
    }
    result.set(Number(sourceRow.r), values);
  }
  return result;
}

function sharedStrings(source: string | undefined): string[] {
  if (!source) return [];
  return asArray(xml.parse(source).sst?.si).map((item) => textOf(item) ?? "");
}
function textOf(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  const node = value as Record<string, unknown>;
  if (typeof node.t === "string") return node.t;
  return asArray(node.r)
    .map(textOf)
    .filter((item): item is string => item !== null)
    .join("");
}
function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? (value as Record<string, unknown>[])
    : value && typeof value === "object"
      ? [value as Record<string, unknown>]
      : [];
}
function columnNumber(ref: string): number | null {
  const match = ref.match(/^([A-Z]+)\d+$/u);
  if (!match) return null;
  return [...(match[1] ?? "")].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0);
}
function required(entries: ReadonlyMap<string, string>, path: string): string {
  const value = entries.get(path);
  if (value === undefined) throw invalid(`В книге отсутствует ${path}`);
  return value;
}
function toIso(value: string): string {
  const [day = "", month = "", year = ""] = value.split(".");
  return `${year}-${month}-${day}`;
}
function invalid(message: string): BadRequestException {
  return new BadRequestException({ code: "MONTHLY_PLAN_FILE_INVALID", message });
}
