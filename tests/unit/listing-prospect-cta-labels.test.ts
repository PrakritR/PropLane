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

  it("says Sign lease instead of Apply for a lease-first listing (PLAN-0927)", () => {
    expect(listingApplyLabel(false, "lease_first")).toBe("Sign lease");
    expect(listingApplyLabel(true, "lease_first")).toBe("Text to sign lease");
  });

  it("keeps the Apply copy for application-first or an unresolved signing order", () => {
    expect(listingApplyLabel(false, "application_first")).toBe("Apply online");
    expect(listingApplyLabel(false, null)).toBe("Apply online");
    expect(listingApplyLabel(false, undefined)).toBe("Apply online");
  });
});
