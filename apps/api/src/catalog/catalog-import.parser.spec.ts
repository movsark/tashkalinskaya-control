import { readFile } from "node:fs/promises";
import path from "node:path";

import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { parseCatalogImport } from "./catalog-import.parser";

const templatePath = path.resolve(
  process.cwd(),
  "../../templates/import/Шаблон_массового_импорта.xlsx",
);

describe("catalog import parser", () => {
  it("accepts the empty normalized v1.0 template", async () => {
    const parsed = await parseCatalogImport(
      await readFile(templatePath),
      "Шаблон.xlsx",
      "2026-08-03",
    );

    expect(parsed).toMatchObject({
      issues: [expect.objectContaining({ code: "EMPTY_IMPORT", severity: "ERROR" })],
      rows: [],
      templateVersion: "v1.0",
    });
  });

  it("reads a product and a zero norm without treating the zero as blank", async () => {
    const zip = await JSZip.loadAsync(await readFile(templatePath));
    await setCells(zip, "xl/worksheets/sheet2.xml", {
      A4: "TKF-00001",
      B4: "Торт контрольный",
      C4: "Торты Базовые",
      D4: "шт",
      E4: "4006381333931",
      F4: "CAKE",
      G4: "Да",
    });
    await setCells(zip, "xl/worksheets/sheet3.xml", {
      A4: "1",
      B4: "Понедельник",
      C4: "TKF-00001",
      D4: "0",
      E4: "2026-08-03",
    });

    const parsed = await parseCatalogImport(
      await zip.generateAsync({ type: "nodebuffer" }),
      "Нормы.xlsx",
      "2026-08-03",
    );

    expect(parsed.issues).toEqual([]);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toMatchObject({ entityType: "PRODUCT", status: "VALID" });
    expect(parsed.rows[1]).toMatchObject({
      entityType: "NORM",
      normalized: { quantity: 0, validFrom: "2026-08-03" },
      status: "SKIPPED_ZERO",
    });
  });

  it("distinguishes a missing quantity from zero", async () => {
    const zip = await JSZip.loadAsync(await readFile(templatePath));
    await setCells(zip, "xl/worksheets/sheet3.xml", {
      A4: "1",
      B4: "Понедельник",
      C4: "TKF-00001",
      E4: "2026-08-03",
    });

    const parsed = await parseCatalogImport(
      await zip.generateAsync({ type: "nodebuffer" }),
      "Нормы.xlsx",
      "2026-08-03",
    );

    expect(parsed.rows[0]?.status).toBe("ERROR");
    expect(parsed.issues).toContainEqual(
      expect.objectContaining({ code: "REQUIRED_VALUE", columnName: "Количество" }),
    );
  });

  it("rejects formulas before row parsing", async () => {
    const zip = await JSZip.loadAsync(await readFile(templatePath));
    const entry = zip.file("xl/worksheets/sheet2.xml");
    if (entry === null) throw new Error("Template sheet is missing");
    const xml = await entry.async("string");
    zip.file(
      "xl/worksheets/sheet2.xml",
      xml.replace('<x:c r="A4" s="53" />', '<x:c r="A4" s="53"><x:f>1+1</x:f><x:v>2</x:v></x:c>'),
    );

    await expect(
      parseCatalogImport(
        await zip.generateAsync({ type: "nodebuffer" }),
        "Формула.xlsx",
        "2026-08-03",
      ),
    ).rejects.toMatchObject({ response: { code: "FORMULA_NOT_ALLOWED" } });
  });
});

async function setCells(zip: JSZip, fileName: string, values: Readonly<Record<string, string>>) {
  const entry = zip.file(fileName);
  if (entry === null) throw new Error(`Template part ${fileName} is missing`);
  let xml = await entry.async("string");
  for (const [reference, value] of Object.entries(values)) {
    const escaped = value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    xml = xml.replace(
      new RegExp(`<x:c r="${reference}" s="[0-9]+" \\/>`),
      `<x:c r="${reference}" t="str"><x:v>${escaped}</x:v></x:c>`,
    );
  }
  zip.file(fileName, xml);
}
