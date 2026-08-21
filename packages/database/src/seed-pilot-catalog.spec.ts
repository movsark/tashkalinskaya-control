import { describe, expect, it } from "vitest";

import { assertExistingCatalog, pilotCatalog, validatePilotCatalog } from "./seed-pilot-catalog";

describe("pilot catalog manifest", () => {
  it("contains the approved 81 unique products", () => {
    expect(() => validatePilotCatalog(pilotCatalog)).not.toThrow();
    expect(pilotCatalog).toHaveLength(81);
    expect(new Set(pilotCatalog.map((product) => product.productCode))).toHaveLength(81);
  });

  it("rejects an incomplete catalog", () => {
    expect(() => validatePilotCatalog(pilotCatalog.slice(1))).toThrow("exactly 81 products");
  });

  it("allows products added after the approved pilot catalog", () => {
    const existing = pilotCatalog.map((product) => ({
      ...product,
      status: "ACTIVE",
      unitCode: "PCS",
    }));

    expect(() =>
      assertExistingCatalog([
        ...existing,
        {
          categoryCode: "SV",
          name: "Новый рабочий товар",
          productCode: "SV-028",
          status: "ACTIVE",
          unitCode: "PCS",
        },
      ]),
    ).not.toThrow();
  });

  it("still rejects a missing approved pilot product", () => {
    const existing = pilotCatalog.slice(1).map((product) => ({
      ...product,
      status: "ACTIVE",
      unitCode: "PCS",
    }));

    expect(() => assertExistingCatalog(existing)).toThrow(
      `differs at ${pilotCatalog[0]?.productCode}`,
    );
  });
});
