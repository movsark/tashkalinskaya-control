import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { parseMonthlyPlan } from "./monthly-plan.parser";

describe("monthly plan parser", () => {
  it("recovers product names from a complete sheet when cached formulas damaged one day", async () => {
    const parsed = await parseMonthlyPlan(await workbookWithFalseProducts(), "План.xlsx");

    expect(parsed.rows).toEqual([
      {
        dispatchDate: "2026-08-17",
        productName: "Торт контрольный",
        quantity: 3,
        sheetName: "17.08 Пн",
        sourceCells: "A4:B4",
        territoryNumber: 1,
      },
    ]);
    expect(parsed.roundings).toEqual([
      expect.objectContaining({ from: 2.5, productName: "Торт контрольный", to: 3 }),
    ]);
  });
});

async function workbookWithFalseProducts(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0"?><Types><Default Extension="xml" ContentType="application/xml"/></Types>',
  );
  zip.file(
    "xl/workbook.xml",
    '<?xml version="1.0"?><workbook xmlns:r="urn:relationships"><sheets><sheet name="16.08 Вс" sheetId="1" r:id="rId1" state="visible"/><sheet name="17.08 Пн" sheetId="2" r:id="rId2" state="visible"/></sheets></workbook>',
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
  );
  zip.file(
    "xl/worksheets/sheet1.xml",
    `<?xml version="1.0"?><worksheet><sheetData>
      <row r="1">${cell("A1", "Территория 1 - Воскресенье 16.08.2026")}</row>
      <row r="3">${cell("A3", "Торт контрольный")}</row>
      ${[54, 107, 160, 213, 266, 319, 372, 425]
        .map(
          (row, index) =>
            `<row r="${row}">${cell(
              `A${row}`,
              `Территория ${index + 2} - Воскресенье 16.08.2026`,
            )}</row>`,
        )
        .join("")}
    </sheetData></worksheet>`,
  );
  zip.file(
    "xl/worksheets/sheet2.xml",
    `<?xml version="1.0"?><worksheet><sheetData>
      <row r="2">${cell("A2", "Территория 1 - Понедельник 17.08.2026")}${cell("B2", "223")}</row>
      <row r="3">${cell("A3", "0")}${cell("B3", "10")}</row>
      <row r="4">${cell("A4", "0")}${cell("B4", "2,5")}</row>
      <row r="54">${cell("A54", "Территория 2 - Понедельник 17.08.2026")}</row>
    </sheetData></worksheet>`,
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

function cell(reference: string, value: string): string {
  return `<c r="${reference}" t="inlineStr"><is><t>${value}</t></is></c>`;
}
