import { describe, expect, it } from "vitest";

import { ROLE_CODES, type ServiceHealth } from "./index";

describe("ServiceHealth contract", () => {
  it("keeps the public health response explicit", () => {
    const response: ServiceHealth = {
      service: "api",
      state: "healthy",
      timestamp: "2026-07-31T00:00:00.000Z",
      version: "0.1.0",
    };

    expect(response.state).toBe("healthy");
    expect(response.service).toBe("api");
  });
});

describe("identity contracts", () => {
  it("contains every approved MVP role", () => {
    expect(ROLE_CODES).toHaveLength(9);
    expect(ROLE_CODES).toContain("ADMIN");
    expect(ROLE_CODES).toContain("ATTENDANCE_ONLY");
  });
});
