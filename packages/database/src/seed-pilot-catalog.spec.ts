import { describe, expect, it } from "vitest";

import { pilotCatalog, validatePilotCatalog } from "./seed-pilot-catalog";

describe("pilot catalog manifest", () => {
  it("contains the approved 81 unique products", () => {
    expect(() => validatePilotCatalog(pilotCatalog)).not.toThrow();
    expect(pilotCatalog).toHaveLength(81);
    expect(new Set(pilotCatalog.map((product) => product.productCode))).toHaveLength(81);
  });

  it("rejects an incomplete catalog", () => {
    expect(() => validatePilotCatalog(pilotCatalog.slice(1))).toThrow("exactly 81 products");
  });
});
