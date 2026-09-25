import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { proplaneBalanceEnabled } from "@/lib/proplane-balance/flag";

describe("proplaneBalanceEnabled", () => {
  const PREV = process.env.PROPLANE_BALANCE_ENABLED;

  beforeEach(() => {
    delete process.env.PROPLANE_BALANCE_ENABLED;
  });

  afterEach(() => {
    if (PREV === undefined) delete process.env.PROPLANE_BALANCE_ENABLED;
    else process.env.PROPLANE_BALANCE_ENABLED = PREV;
  });

  it("defaults OFF when unset", () => {
    expect(proplaneBalanceEnabled()).toBe(false);
  });

  it("is off for an empty string, '0', or any other value", () => {
    for (const value of ["", "0", "no", "false", " 1x"]) {
      process.env.PROPLANE_BALANCE_ENABLED = value;
      expect(proplaneBalanceEnabled()).toBe(false);
    }
  });

  it("is on for '1' or 'true' (case/whitespace-insensitive)", () => {
    for (const value of ["1", "true", "TRUE", " 1 ", " true "]) {
      process.env.PROPLANE_BALANCE_ENABLED = value;
      expect(proplaneBalanceEnabled()).toBe(true);
    }
  });
});
