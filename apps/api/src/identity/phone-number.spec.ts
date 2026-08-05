import { BadRequestException } from "@nestjs/common";
import { describe, expect, it } from "vitest";

import { maskPhone, normalizePhone } from "./phone-number";

describe("phone number normalization", () => {
  it.each([
    ["8 (900) 123-45-67", "+79001234567"],
    ["79001234567", "+79001234567"],
    ["+7 900 123 45 67", "+79001234567"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it("rejects malformed and short numbers", () => {
    expect(() => normalizePhone("12345")).toThrow(BadRequestException);
    expect(() => normalizePhone("+7000ABC0000")).toThrow(BadRequestException);
    expect(() => normalizePhone("+375 29 123-45-67")).toThrow(BadRequestException);
  });

  it("never exposes the full verified number", () => {
    expect(maskPhone("+79001234567")).toBe("+7 ••• •••-45-67");
    expect(maskPhone(null)).toBeNull();
  });
});
