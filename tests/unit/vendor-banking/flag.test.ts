import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vendorBankingEnabled } from "@/lib/vendor-banking/flag";

describe("vendorBankingEnabled", () => {
  const PREV = process.env.VENDOR_BANKING_ENABLED;

  beforeEach(() => {
    delete process.env.VENDOR_BANKING_ENABLED;
  });

  afterEach(() => {
    if (PREV === undefined) delete process.env.VENDOR_BANKING_ENABLED;
    else process.env.VENDOR_BANKING_ENABLED = PREV;
  });

  it("defaults ON when unset (captain, 2026-09-28)", () => {
    expect(vendorBankingEnabled()).toBe(true);
  });

  it("is off for '0', 'false', or 'off' (case/whitespace-insensitive)", () => {
    for (const value of ["0", "false", "off", "FALSE", "OFF", " 0 ", " false ", " off "]) {
      process.env.VENDOR_BANKING_ENABLED = value;
      expect(vendorBankingEnabled()).toBe(false);
    }
  });

  it("is on for '1', 'true', an empty string, or any other value", () => {
    for (const value of ["1", "true", "TRUE", " 1 ", " true ", "", "no", " 1x"]) {
      process.env.VENDOR_BANKING_ENABLED = value;
      expect(vendorBankingEnabled()).toBe(true);
    }
  });
});
