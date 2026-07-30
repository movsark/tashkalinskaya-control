import { describe, expect, it } from "vitest";

import type { ServiceHealth } from "./index";

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
