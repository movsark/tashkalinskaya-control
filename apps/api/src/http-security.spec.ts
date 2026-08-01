import { describe, expect, it, vi } from "vitest";

import { originProtection, requestOriginAllowed } from "./http-security";

describe("HTTP origin protection", () => {
  const allowed = ["https://control.factory.example"];

  it("allows safe reads and exact configured origins", () => {
    expect(requestOriginAllowed("GET", "https://attacker.example", allowed)).toBe(true);
    expect(requestOriginAllowed("POST", "https://control.factory.example", allowed)).toBe(true);
    expect(requestOriginAllowed("POST", undefined, allowed)).toBe(true);
  });

  it("rejects lookalike and prefixed origins", () => {
    expect(
      requestOriginAllowed("POST", "https://control.factory.example.attacker.test", allowed),
    ).toBe(false);
    expect(
      requestOriginAllowed("POST", "https://attacker.test/control.factory.example", allowed),
    ).toBe(false);
  });

  it("returns a stable safe error without calling the application", () => {
    const request = {
      header: vi.fn().mockReturnValue("https://attacker.example"),
      method: "POST",
    };
    const json = vi.fn();
    const response = { json, status: vi.fn().mockReturnValue({ json }) };
    const next = vi.fn();
    originProtection(allowed)(request as never, response as never, next);
    expect(response.status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({
      code: "ORIGIN_REJECTED",
      message: "Источник запроса не разрешен",
    });
    expect(next).not.toHaveBeenCalled();
  });
});
