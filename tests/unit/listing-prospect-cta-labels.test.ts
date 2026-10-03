import { describe, expect, it } from "vitest";
import { listingApplyLabel, listingMessageLabel } from "@/lib/listing-prospect-cta-labels";

describe("listing-prospect-cta-labels", () => {
  it("uses Send message for web listing CTAs", () => {
    expect(listingMessageLabel(false)).toBe("Send message");
    expect(listingApplyLabel(false)).toBe("Apply online");
  });

  it("uses SMS copy when claw texting is enabled", () => {
    expect(listingMessageLabel(true)).toBe("Text a message");
    expect(listingApplyLabel(true)).toBe("Text to apply");
  });

  it("never says Sign lease: lease first is gone, so even a stale lease_first value reads Apply", () => {
    expect(listingApplyLabel(false, "lease_first" as never)).toBe("Apply online");
    expect(listingApplyLabel(true, "lease_first" as never)).toBe("Text to apply");
  });

  it("keeps the Apply copy for application-first or an unresolved signing order", () => {
    expect(listingApplyLabel(false, "application_first")).toBe("Apply online");
    expect(listingApplyLabel(false, null)).toBe("Apply online");
    expect(listingApplyLabel(false, undefined)).toBe("Apply online");
  });
});
