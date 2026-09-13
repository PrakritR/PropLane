import { describe, expect, it } from "vitest";
import {
  listingApplicationFeeChargePolicy,
  resolveApplicationFeeChargePolicy,
} from "@/lib/rental-application/listing-application-fee-policy";

describe("listing application fee policy", () => {
  it("maps the returning-resident checkbox to first_only / every_time", () => {
    expect(listingApplicationFeeChargePolicy({ waiveApplicationFeeForReturningResidents: true })).toBe("first_only");
    expect(listingApplicationFeeChargePolicy({ waiveApplicationFeeForReturningResidents: false })).toBe("every_time");
  });

  it("falls back to the manager policy when the listing is silent", () => {
    expect(resolveApplicationFeeChargePolicy({}, "first_only")).toBe("first_only");
    expect(resolveApplicationFeeChargePolicy({}, "every_time")).toBe("every_time");
  });

  it("lets the listing override the manager policy", () => {
    expect(
      resolveApplicationFeeChargePolicy({ waiveApplicationFeeForReturningResidents: false }, "first_only"),
    ).toBe("every_time");
    expect(
      resolveApplicationFeeChargePolicy({ waiveApplicationFeeForReturningResidents: true }, "every_time"),
    ).toBe("first_only");
  });

  it("still reads the legacy only-first flag", () => {
    expect(listingApplicationFeeChargePolicy({ applicationFeeOnlyFirstApplication: true })).toBe("first_only");
  });
});
