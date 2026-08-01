import type { ReportSnapshot } from "@tashkalinskaya/contracts";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { buildReportFile } from "./report.processor";

const snapshot: ReportSnapshot = {
  columns: [
    { key: "product", label: "Товар", numeric: false, total: false, width: 28 },
    { key: "quantity", label: "Количество", numeric: true, total: true, width: 14 },
  ],
  dateFrom: "2026-07-30",
  dateTo: "2026-07-30",
  generatedAt: "2026-07-30T07:00:00.000Z",
  reportCode: "MOVEMENTS",
  requesterName: "Администратор фабрики",
  rows: [
    { product: "Наполеон", quantity: 12 },
    { product: "Медовик", quantity: 8 },
  ],
  templateVersion: "b18-v1",
  title: "Тестовый отчет",
  totals: { quantity: 20 },
};

describe("report artifacts", () => {
  it("builds a readable XLSX with totals and filters", async () => {
    const file = await buildReportFile(snapshot, "XLSX");
    expect(file.body.subarray(0, 2).toString()).toBe("PK");
    const zip = await JSZip.loadAsync(file.body);
    const sheet = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
    expect(sheet).toContain("Тестовый отчет");
    expect(sheet).toContain('<c r="B9" s="6"><v>20</v></c>');
    expect(sheet).toContain('<autoFilter ref="A6:B8"/>');
  });

  it("builds a PDF with embedded Cyrillic font", async () => {
    const file = await buildReportFile(snapshot, "PDF");
    expect(file.body.subarray(0, 5).toString()).toBe("%PDF-");
    expect(file.body.length).toBeGreaterThan(2_000);
  });
});
