import { describe, expect, it } from "vitest";

import { isDatabaseConfigured } from "./index";

describe("isDatabaseConfigured", () => {
  it("rejects an absent or blank database URL", () => {
    expect(isDatabaseConfigured(undefined)).toBe(false);
    expect(isDatabaseConfigured("  ")).toBe(false);
  });

  it("accepts a non-empty database URL", () => {
    expect(isDatabaseConfigured("postgresql://localhost/factory")).toBe(true);
  });
});
