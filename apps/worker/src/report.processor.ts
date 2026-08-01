import { createHash } from "node:crypto";

import type { ReportExportFormat, ReportSnapshot } from "@tashkalinskaya/contracts";
import JSZip from "jszip";
import PDFDocument from "pdfkit";
import type { Pool, QueryResultRow } from "pg";

interface ClaimedJob extends QueryResultRow {
  attempt_count: number;
  export_format: ReportExportFormat;
  id: string;
  snapshot: ReportSnapshot;
}

export interface ReportCycleResult {
  readonly expired: number;
  readonly failed: number;
  readonly generated: number;
}

export class ReportProcessor {
  constructor(private readonly pool: Pool) {}

  async runCycle(): Promise<ReportCycleResult> {
    const expired = await this.expireArtifacts();
    let failed = 0;
    let generated = 0;
    await this.requeueStaleJobs();
    for (let index = 0; index < 3; index += 1) {
      const job = await this.claim();
      if (!job) break;
      try {
        const file = await buildReportFile(job.snapshot, job.export_format);
        const digest = createHash("sha256").update(file.body).digest("hex");
        await this.pool.query(
          `update reporting.report_job set status='READY',completed_at=now(),
             file_name=$2,content_type=$3,artifact=$4,artifact_size=$5,artifact_sha256=$6,
             error_code=null,error_message=null where id=$1 and status='RUNNING'`,
          [job.id, file.fileName, file.contentType, file.body, file.body.length, digest],
        );
        generated += 1;
      } catch (error) {
        await this.fail(job, error);
        failed += 1;
      }
    }
    return { expired, failed, generated };
  }

  private async claim(): Promise<ClaimedJob | null> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await client.query<ClaimedJob>(
        `with candidate as (
           select id from reporting.report_job where status='QUEUED'
           order by requested_at for update skip locked limit 1
         ) update reporting.report_job j set status='RUNNING',started_at=now(),
             attempt_count=j.attempt_count+1,error_code=null,error_message=null
           from candidate where j.id=candidate.id
           returning j.id,j.export_format,j.snapshot,j.attempt_count`,
      );
      await client.query("commit");
      return result.rows[0] ?? null;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  private async fail(job: ClaimedJob, error: unknown): Promise<void> {
    const safeMessage = error instanceof Error ? error.message.slice(0, 500) : "Ошибка генерации";
    if (job.attempt_count < 3) {
      await this.pool.query(
        `update reporting.report_job set status='QUEUED',started_at=null,
           error_code='GENERATION_RETRY',error_message=$2 where id=$1 and status='RUNNING'`,
        [job.id, safeMessage],
      );
      return;
    }
    await this.pool.query(
      `update reporting.report_job set status='FAILED',completed_at=now(),
         error_code='GENERATION_FAILED',error_message=$2 where id=$1 and status='RUNNING'`,
      [job.id, safeMessage],
    );
  }

  private async requeueStaleJobs(): Promise<void> {
    await this.pool.query(
      `update reporting.report_job set status=case when attempt_count>=3 then 'FAILED' else 'QUEUED' end,
         started_at=null,completed_at=case when attempt_count>=3 then now() else null end,
         error_code='WORKER_TIMEOUT',error_message='Формирование прервано и будет повторено'
       where status='RUNNING' and started_at<now()-interval '10 minutes'`,
    );
  }

  private async expireArtifacts(): Promise<number> {
    const result = await this.pool.query(
      `update reporting.report_job set status='EXPIRED',artifact=null,artifact_size=null,
         artifact_sha256=null,error_code=null,error_message=null
       where status='READY' and expires_at<=now()`,
    );
    return result.rowCount ?? 0;
  }
}

export async function buildReportFile(snapshot: ReportSnapshot, format: ReportExportFormat) {
  return format === "XLSX" ? buildXlsx(snapshot) : buildPdf(snapshot);
}

async function buildXlsx(snapshot: ReportSnapshot) {
  const zip = new JSZip();
  const lastColumn = columnName(Math.max(1, snapshot.columns.length));
  const rows: string[] = [xlsxRow(1, [xlsxTextCell("A1", snapshot.title, 1)], 34)];
  const meta = [
    ["Период", `${snapshot.dateFrom} — ${snapshot.dateTo}`],
    ["Снимок данных", formatMoscow(snapshot.generatedAt)],
    ["Сформировал", snapshot.requesterName],
    ["Версия формы", snapshot.templateVersion],
  ];
  meta.forEach(([label, value], index) =>
    rows.push(
      xlsxRow(index + 2, [
        xlsxTextCell(`A${index + 2}`, label!, 2),
        xlsxTextCell(`B${index + 2}`, value!, 0),
      ]),
    ),
  );
  rows.push(
    xlsxRow(
      6,
      snapshot.columns.map((column, index) =>
        xlsxTextCell(`${columnName(index + 1)}6`, column.label, 3),
      ),
      30,
    ),
  );
  snapshot.rows.forEach((row, rowIndex) => {
    const excelRow = rowIndex + 7;
    rows.push(
      xlsxRow(
        excelRow,
        snapshot.columns.map((column, columnIndex) =>
          xlsxCell(
            `${columnName(columnIndex + 1)}${excelRow}`,
            row[column.key],
            column.numeric ? 4 : 5,
          ),
        ),
      ),
    );
  });
  if (snapshot.rows.length > 0) {
    const totalRow = snapshot.rows.length + 7;
    rows.push(
      xlsxRow(
        totalRow,
        snapshot.columns.map((column, index) =>
          xlsxCell(
            `${columnName(index + 1)}${totalRow}`,
            index === 0 ? "Итого" : column.total ? (snapshot.totals[column.key] ?? 0) : "",
            6,
          ),
        ),
      ),
    );
  }
  const widths = snapshot.columns
    .map(
      (column, index) =>
        `<col min="${index + 1}" max="${index + 1}" width="${Math.min(45, Math.max(index === 0 ? 16 : 10, column.width))}" customWidth="1"/>`,
    )
    .join("");
  const lastDataRow = 6 + Math.max(1, snapshot.rows.length);
  zip.file("[Content_Types].xml", contentTypesXml());
  zip.file("_rels/.rels", packageRelsXml());
  zip.file("docProps/app.xml", appXml());
  zip.file("docProps/core.xml", coreXml(snapshot));
  zip.file("xl/workbook.xml", workbookXml());
  zip.file("xl/_rels/workbook.xml.rels", workbookRelsXml());
  zip.file("xl/styles.xml", stylesXml());
  zip.file(
    "xl/worksheets/sheet1.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
      <sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>
      <dimension ref="A1:${lastColumn}${snapshot.rows.length + 7}"/>
      <sheetViews><sheetView workbookViewId="0"><pane ySplit="6" topLeftCell="A7" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
      <sheetFormatPr defaultRowHeight="18"/><cols>${widths}</cols><sheetData>${rows.join("")}</sheetData>
      <autoFilter ref="A6:${lastColumn}${lastDataRow}"/>
      <mergeCells count="1"><mergeCell ref="A1:${lastColumn}1"/></mergeCells>
      <pageMargins left="0.35" right="0.35" top="0.55" bottom="0.55" header="0.2" footer="0.2"/>
      <pageSetup paperSize="9" orientation="${snapshot.columns.length > 6 ? "landscape" : "portrait"}" fitToWidth="1" fitToHeight="0"/>
      <headerFooter><oddFooter>&amp;CТашкалинская · конфиденциально · &amp;P / &amp;N</oddFooter></headerFooter>
    </worksheet>`,
  );
  const output = await zip.generateAsync({
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
    type: "nodebuffer",
  });
  return {
    body: output,
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    fileName: fileName(snapshot, "xlsx"),
  };
}

function xlsxRow(number: number, cells: readonly string[], height?: number): string {
  return `<row r="${number}"${height ? ` ht="${height}" customHeight="1"` : ""}>${cells.join("")}</row>`;
}

function xlsxCell(reference: string, value: unknown, style: number): string {
  if (typeof value === "number" && Number.isFinite(value))
    return `<c r="${reference}" s="${style}"><v>${value}</v></c>`;
  return xlsxTextCell(reference, value === null || value === undefined ? "" : String(value), style);
}

function xlsxTextCell(reference: string, value: string, style: number): string {
  return `<c r="${reference}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
}

function columnName(index: number): string {
  let value = index;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function contentTypesXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;
}
function packageRelsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`;
}
function workbookXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets><sheet name="Отчет" sheetId="1" r:id="rId1"/></sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`;
}
function workbookRelsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
}
function appXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Ташкалинская — внутренний контроль</Application></Properties>`;
}
function coreXml(snapshot: ReportSnapshot): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(snapshot.title)}</dc:title><dc:creator>${xml(snapshot.requesterName)}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${snapshot.generatedAt}</dcterms:created></cp:coreProperties>`;
}
function stylesXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0"/></numFmts><fonts count="4"><font><sz val="10"/><name val="Arial"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="18"/><name val="Arial"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="10"/><name val="Arial"/></font><font><b/><color rgb="FF173C34"/><sz val="10"/><name val="Arial"/></font></fonts><fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF173C34"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF6D995"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border/><border><bottom style="hair"><color rgb="FFE5E1D8"/></bottom></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="7"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="2" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"><alignment wrapText="1" vertical="center"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"><alignment wrapText="1" vertical="top"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"><alignment wrapText="1" vertical="top"/></xf><xf numFmtId="164" fontId="3" fillId="3" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
}

async function buildPdf(snapshot: ReportSnapshot) {
  const landscape = snapshot.columns.length > 6;
  const document = new PDFDocument({
    layout: landscape ? "landscape" : "portrait",
    margin: 32,
    size: "A4",
    bufferPages: true,
    info: {
      Author: snapshot.requesterName,
      CreationDate: new Date(snapshot.generatedAt),
      Title: snapshot.title,
    },
  });
  const font = require.resolve("next/dist/compiled/@vercel/og/Geist-Regular.ttf");
  document.registerFont("Report", font).registerFont("ReportBold", font);
  const chunks: Buffer[] = [];
  document.on("data", (chunk: Buffer) => chunks.push(chunk));
  const result = new Promise<Buffer>((resolve, reject) => {
    document.on("end", () => resolve(Buffer.concat(chunks)));
    document.on("error", reject);
  });

  const usableWidth = document.page.width - 64;
  const widthTotal = snapshot.columns.reduce((sum, item) => sum + item.width, 0);
  const widths = snapshot.columns.map((item) => (item.width / widthTotal) * usableWidth);
  const drawTitle = () => {
    document.font("ReportBold").fontSize(16).fillColor("#173c34").text(snapshot.title);
    document
      .moveDown(0.35)
      .font("Report")
      .fontSize(8)
      .fillColor("#5f6863")
      .text(
        `Период: ${snapshot.dateFrom} — ${snapshot.dateTo} · Снимок: ${formatMoscow(snapshot.generatedAt)} · Сформировал: ${snapshot.requesterName} · Форма: ${snapshot.templateVersion}`,
      );
    document.moveDown(0.7);
  };
  const drawHeader = () => {
    const y = document.y;
    document.save().fillColor("#173c34").rect(32, y, usableWidth, 25).fill();
    let x = 32;
    snapshot.columns.forEach((column, index) => {
      document
        .font("ReportBold")
        .fontSize(7)
        .fillColor("#ffffff")
        .text(column.label, x + 3, y + 5, { height: 18, width: widths[index]! - 6 });
      x += widths[index]!;
    });
    document.restore();
    document.y = y + 25;
  };
  const newPage = () => {
    document.addPage();
    drawTitle();
    drawHeader();
  };
  drawTitle();
  drawHeader();
  snapshot.rows.forEach((row, rowIndex) => {
    const values = snapshot.columns.map((column) => displayCell(row[column.key]));
    const heights = values.map((value, index) =>
      document
        .font("Report")
        .fontSize(7)
        .heightOfString(value, { width: widths[index]! - 6 }),
    );
    const rowHeight = Math.max(18, ...heights) + 6;
    if (document.y + rowHeight > document.page.height - 46) newPage();
    const y = document.y;
    if (rowIndex % 2 === 1)
      document.save().fillColor("#f6f3ec").rect(32, y, usableWidth, rowHeight).fill().restore();
    let x = 32;
    values.forEach((value, index) => {
      document
        .font("Report")
        .fontSize(7)
        .fillColor("#202520")
        .text(value, x + 3, y + 4, { height: rowHeight - 6, width: widths[index]! - 6 });
      x += widths[index]!;
    });
    document.y = y + rowHeight;
  });
  if (Object.keys(snapshot.totals).length > 0) {
    if (document.y + 24 > document.page.height - 46) newPage();
    const totals = snapshot.columns.map((column, index) =>
      index === 0 ? "Итого" : column.total ? String(snapshot.totals[column.key] ?? 0) : "",
    );
    const y = document.y;
    document.save().fillColor("#f6d995").rect(32, y, usableWidth, 22).fill().restore();
    let x = 32;
    totals.forEach((value, index) => {
      document
        .font("ReportBold")
        .fontSize(7)
        .fillColor("#173c34")
        .text(value, x + 3, y + 5, { width: widths[index]! - 6 });
      x += widths[index]!;
    });
  }
  const pages = document.bufferedPageRange();
  for (let page = 0; page < pages.count; page += 1) {
    document.switchToPage(page);
    const previousBottomMargin = document.page.margins.bottom;
    document.page.margins.bottom = 0;
    document
      .font("Report")
      .fontSize(7)
      .fillColor("#777d78")
      .text(
        `Ташкалинская · конфиденциально · ${page + 1} / ${pages.count}`,
        32,
        document.page.height - 20,
        { align: "center", height: 10, lineBreak: false, width: usableWidth },
      );
    document.page.margins.bottom = previousBottomMargin;
  }
  document.end();
  return {
    body: await result,
    contentType: "application/pdf",
    fileName: fileName(snapshot, "pdf"),
  };
}

function displayCell(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "number")
    return new Intl.NumberFormat("ru-RU").format(Math.round(value * 100) / 100);
  return String(value);
}

function formatMoscow(value: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Europe/Moscow",
  }).format(new Date(value));
}

function fileName(snapshot: ReportSnapshot, extension: string): string {
  return `${snapshot.reportCode.toLowerCase()}_${snapshot.dateFrom}_${snapshot.dateTo}_${snapshot.generatedAt.slice(0, 19).replaceAll(":", "-")}.${extension}`;
}
