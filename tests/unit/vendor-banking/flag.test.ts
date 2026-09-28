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

  it("defaults OFF when unset", () => {
    expect(vendorBankingEnabled()).toBe(false);
  });

  it("is off for an empty string, '0', or any other value", () => {
    for (const value of ["", "0", "no", "false", " 1x"]) {
      process.env.VENDOR_BANKING_ENABLED = value;
      expect(vendorBankingEnabled()).toBe(false);
    }
  });

  it("is on for '1' or 'true' (case/whitespace-insensitive)", () => {
    for (const value of ["1", "true", "TRUE", " 1 ", " true "]) {
      process.env.VENDOR_BANKING_ENABLED = value;
      expect(vendorBankingEnabled()).toBe(true);
    }
  });
});
