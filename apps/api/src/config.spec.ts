import { describe, expect, it } from "vitest";

import { loadApiConfig } from "./config";

describe("loadApiConfig", () => {
  it("loads safe local defaults", () => {
    const config = loadApiConfig({});

    expect(config.port).toBe(4000);
    expect(config.databaseRequired).toBe(false);
    expect(config.corsOrigins).toEqual(["http://localhost:3000"]);
  });

  it("rejects an invalid port", () => {
    expect(() => loadApiConfig({ API_PORT: "70000" })).toThrow();
  });
});
