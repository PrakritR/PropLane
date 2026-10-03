// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { LISTING_V2_STEPS } from "@/components/portal/listing-wizard-v2/listing-editor";

describe("listing wizard — no Pricing step (studio 0929)", () => {
  it("has five steps and Pricing is not one of them", () => {
    const ids = LISTING_V2_STEPS.map((s) => s.id);
    expect(ids).toEqual(["basics", "rooms", "bathrooms", "spaces", "review"]);
    expect(ids).not.toContain("pricing");
  });
});
