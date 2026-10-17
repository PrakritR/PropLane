import { describe, expect, it } from "vitest";
import { applicationFeeProductDescription, applicationFeePropertyTitle } from "@/lib/application-fee-checkout.server";

describe("application fee Stripe line item", () => {
  it("names the house, never the raw property id", () => {
    const title = applicationFeePropertyTitle({ buildingName: "Ballard House", unitLabel: "5 rooms", title: "x" });
    expect(title).toBe("Ballard House · 5 rooms");
    expect(applicationFeeProductDescription(title)).toBe("Ballard House · 5 rooms");
    expect(applicationFeeProductDescription(title)).not.toMatch(/Listing /);
  });

  it("falls back to the stored title, then to a neutral label", () => {
    expect(applicationFeePropertyTitle({ title: "Alder Row" })).toBe("Alder Row");
    expect(applicationFeePropertyTitle(null)).toBe("");
    expect(applicationFeeProductDescription("")).toBe("Rental application");
  });
});
