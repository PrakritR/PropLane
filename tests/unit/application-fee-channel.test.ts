import { describe, expect, it } from "vitest";
import {
  createDefaultListingServiceOptions,
  createDefaultListingSubmission,
  isListingFeeAmountFilled,
  LISTING_SERVICE_QUICK_ADDS,
  mergeResidentServiceCatalogOffers,
  normalizeManagerListingSubmissionV1,
  resolveAllowedLeaseTerms,
} from "@/lib/manager-listing-submission";
import { buildServiceIntakeOptions } from "@/lib/service-intake";
import {
  listingApplicationFeeChannels,
  resolveApplicationFeePayChannel,
} from "@/lib/rental-application/application-fee-channel";

describe("manager-listing-submission new fields", () => {
  it("normalizes house move-in and application fee other fields", () => {
    const sub = normalizeManagerListingSubmissionV1({
      ...createDefaultListingSubmission(),
      houseMoveInAvailableDate: "2026-07-01",
      houseMoveInInstructions: "Pick up keys at front desk.",
      applicationFeeOtherEnabled: true,
      applicationFeeOtherInstructions: "Pay by check at office.",
    });
    expect(sub.houseMoveInAvailableDate).toBe("2026-07-01");
    expect(sub.houseMoveInInstructions).toBe("Pick up keys at front desk.");
    expect(sub.applicationFeeOtherEnabled).toBe(true);
    expect(sub.applicationFeeOtherInstructions).toBe("Pay by check at office.");
  });

  it("createDefaultListingServiceOptions starts empty", () => {
    expect(createDefaultListingServiceOptions()).toEqual([]);
  });

  it("LISTING_SERVICE_QUICK_ADDS includes cleaning, linen, and storage", () => {
    const names = LISTING_SERVICE_QUICK_ADDS.map((o) => o.name);
    expect(names).toContain("Weekly cleaning");
    expect(names).toContain("Linen refresh");
    expect(names).toContain("Storage locker");
  });

  it("mergeResidentServiceCatalogOffers adds house presets when the catalog is empty", () => {
    const merged = mergeResidentServiceCatalogOffers([]);
    expect(merged.map((offer) => offer.name)).toEqual([
      "Weekly cleaning",
      "Linen refresh",
      "Storage locker",
    ]);
    const intake = buildServiceIntakeOptions(merged);
    expect(intake.some((option) => option.label.includes("Weekly cleaning"))).toBe(true);
    expect(intake.some((option) => option.label === "Maintenance")).toBe(true);
  });
});

describe("application-fee-channel", () => {
  it("resolves other channel when enabled with instructions", () => {
    const sub = normalizeManagerListingSubmissionV1({
      ...createDefaultListingSubmission(),
      applicationFeeStripeEnabled: false,
      axisPaymentsEnabled: false,
      applicationFeeOtherEnabled: true,
      applicationFeeOtherInstructions: "Mail check to 123 Main St.",
    });
    const channels = listingApplicationFeeChannels(sub);
    expect(channels.other).toBe(true);
    expect(resolveApplicationFeePayChannel(sub, "other")).toBe("other");
  });

  it("includes zelle and venmo when contacts are set", () => {
    const sub = normalizeManagerListingSubmissionV1({
      ...createDefaultListingSubmission(),
      zellePaymentsEnabled: true,
      zelleContact: "pay@example.com",
      venmoPaymentsEnabled: true,
      venmoContact: "@landlord",
    });
    const channels = listingApplicationFeeChannels(sub);
    expect(channels.zelle).toBe(true);
    expect(channels.venmo).toBe(true);
  });

  it("includes ACH when axis payments are enabled", () => {
    const sub = normalizeManagerListingSubmissionV1({
      ...createDefaultListingSubmission(),
      axisPaymentsEnabled: true,
    });
    expect(listingApplicationFeeChannels(sub).ach).toBe(true);
  });

  it("excludes ACH when axis payments are disabled", () => {
    const sub = normalizeManagerListingSubmissionV1({
      ...createDefaultListingSubmission(),
      axisPaymentsEnabled: false,
    });
    expect(listingApplicationFeeChannels(sub).ach).toBe(false);
  });
});

describe("listing fee and lease term helpers", () => {
  it("requires numeric fee amounts including zero", () => {
    expect(isListingFeeAmountFilled("0")).toBe(true);
    expect(isListingFeeAmountFilled("")).toBe(false);
    expect(isListingFeeAmountFilled("Waived")).toBe(false);
  });

  it("normalizes allowed lease terms from checkboxes", () => {
    const sub = normalizeManagerListingSubmissionV1({
      ...createDefaultListingSubmission(),
      allowedLeaseTerms: ["12-Month", "Month-to-Month"],
    });
    expect(resolveAllowedLeaseTerms(sub)).toEqual(["12-Month", "Month-to-Month"]);
    expect(sub.leaseTermsBody).toContain("12-Month");
  });
});
