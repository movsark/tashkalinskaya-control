import { describe, expect, it } from "vitest";

import { normalizeUploadFileName } from "./catalog-upload-name";

describe("normalizeUploadFileName", () => {
  it("restores a UTF-8 Cyrillic name decoded as latin1 by multipart", () => {
    const mojibake = Buffer.from("Шаблон_импорта.xlsx", "utf8").toString("latin1");

    expect(normalizeUploadFileName(mojibake)).toBe("Шаблон_импорта.xlsx");
  });

  it("keeps an ordinary ASCII file name unchanged", () => {
    expect(normalizeUploadFileName("catalog-import.xlsx")).toBe("catalog-import.xlsx");
  });
});
