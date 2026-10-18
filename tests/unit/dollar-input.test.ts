import { describe, expect, it } from "vitest";
import { bpsToPercentInput, centsToDollarsInput, parseDollarsToCents, parsePercentToBps } from "@/lib/dollar-input";

describe("dollar-input", () => {
  it("turns typed dollars into integer cents", () => {
    expect(parseDollarsToCents("12.5")).toBe(1250);
    expect(parseDollarsToCents("$1,250.05")).toBe(125_005);
    expect(parseDollarsToCents("7")).toBe(700);
  });
  it("refuses non-amounts, and zero unless allowed", () => {
    for (const bad of ["", "abc", "1.234", "-5", "1e3", "1..2"]) expect(parseDollarsToCents(bad, true)).toBeNull();
    expect(parseDollarsToCents("0")).toBeNull();
    expect(parseDollarsToCents("0.00", true)).toBe(0);
  });
  it("round-trips a prefill", () => {
    expect(centsToDollarsInput(240_000)).toBe("2400.00");
    expect(centsToDollarsInput(5)).toBe("0.05");
    expect(parseDollarsToCents(centsToDollarsInput(123_457))).toBe(123_457);
  });
  it("converts percent to basis points and back", () => {
    expect(parsePercentToBps("90")).toBe(9000);
    expect(parsePercentToBps("87.5%")).toBe(8750);
    expect(parsePercentToBps("0")).toBe(0);
    expect(parsePercentToBps("0", false)).toBeNull();
    expect(parsePercentToBps("12.345")).toBeNull();
    expect(bpsToPercentInput(9000)).toBe("90");
    expect(bpsToPercentInput(8750)).toBe("87.5");
    expect(bpsToPercentInput(1005)).toBe("10.05");
  });
});
