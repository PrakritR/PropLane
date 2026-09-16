/**
 * The application fee per lease type (the captain, 2026-09-15): one amount, and a
 * map holding only the lease types priced differently. A type with no entry
 * follows the one amount; the legacy short-term fee is still the stay fallback.
 */
import { describe, expect, it } from "vitest";
import {
  applicationFeeLeaseTypeKey,
  listingApplicationFeeRaw,
  normalizeApplicationFeeByLeaseType,
} from "@/lib/listing-application-fee";
import {
  createDefaultListingSubmission,
  normalizeManagerListingSubmissionV1,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";

const listing = (over: Partial<ManagerListingSubmissionV1>): ManagerListingSubmissionV1 =>
  ({ ...createDefaultListingSubmission(), ...over }) as ManagerListingSubmissionV1;

describe("listingApplicationFeeRaw per lease type", () => {
  it("a lease type's own entry wins; a type without one follows the one amount", () => {
    const sub = listing({ applicationFee: "50", applicationFeeByLeaseType: { "Month-to-Month": "25" } });
    expect(listingApplicationFeeRaw(sub, "standard", "Month-to-Month")).toBe("25");
    expect(listingApplicationFeeRaw(sub, "standard", "Long-term")).toBe("50");
    expect(listingApplicationFeeRaw(sub, "standard", "Custom")).toBe("50");
    expect(listingApplicationFeeRaw(sub, "standard")).toBe("50");
  });

  it("a retired fixed length is priced as Long-term", () => {
    const sub = listing({ applicationFee: "50", applicationFeeByLeaseType: { "Long-term": "40" } });
    expect(listingApplicationFeeRaw(sub, "standard", "12-Month")).toBe("40");
    expect(applicationFeeLeaseTypeKey("6-Month")).toBe("Long-term");
  });

  it("keeps the legacy short-term fee as the stay fallback, under the map entry", () => {
    const legacy = listing({ applicationFee: "50", shortTermApplicationFee: "20" });
    expect(listingApplicationFeeRaw(legacy, "short_term")).toBe("20");
    expect(listingApplicationFeeRaw(legacy, "standard", "Short-Term Stay")).toBe("20");
    expect(listingApplicationFeeRaw(legacy, "standard", "Airbnb")).toBe("20");
    expect(listingApplicationFeeRaw(legacy, "standard", "Long-term")).toBe("50");

    const both = listing({ applicationFee: "50", shortTermApplicationFee: "20", applicationFeeByLeaseType: { "Short-Term Stay": "15" } });
    expect(listingApplicationFeeRaw(both, "short_term", "Short-Term Stay")).toBe("15");
    // Airbnb has no entry of its own: the legacy stay fee still applies to it.
    expect(listingApplicationFeeRaw(both, "short_term", "Airbnb")).toBe("20");
  });

  it("an unknown or empty lease term falls through to the one amount", () => {
    const sub = listing({ applicationFee: "50", applicationFeeByLeaseType: { "Month-to-Month": "25" } });
    expect(listingApplicationFeeRaw(sub, "standard", "")).toBe("50");
    expect(listingApplicationFeeRaw(sub, "standard", "Not a term")).toBe("50");
    expect(listingApplicationFeeRaw(null, "standard", "Month-to-Month")).toBe("");
  });
});

describe("normalizeApplicationFeeByLeaseType", () => {
  it("keeps only offered lease types with a typed amount, and stores nothing when nothing differs", () => {
    expect(normalizeApplicationFeeByLeaseType(undefined, ["Long-term"])).toBeUndefined();
    expect(normalizeApplicationFeeByLeaseType({}, ["Long-term"])).toBeUndefined();
    expect(normalizeApplicationFeeByLeaseType({ "Long-term": "" }, ["Long-term"])).toBeUndefined();
    expect(normalizeApplicationFeeByLeaseType({ "Long-term": 40 }, ["Long-term"])).toBeUndefined();
    expect(
      normalizeApplicationFeeByLeaseType({ "Month-to-Month": "25", Custom: "30" }, ["Long-term", "Month-to-Month"]),
    ).toEqual({ "Month-to-Month": "25" });
  });

  it("a retired length offered on the listing keys as Long-term", () => {
    expect(normalizeApplicationFeeByLeaseType({ "12-Month": "40" }, ["12-Month"])).toEqual({ "Long-term": "40" });
  });

  it("the submission normaliser prunes a lease type the listing no longer offers", () => {
    const sub = normalizeManagerListingSubmissionV1(
      listing({
        applicationFee: "50",
        allowedLeaseTerms: ["Long-term", "Month-to-Month"],
        applicationFeeByLeaseType: { "Month-to-Month": "25", Custom: "30" },
      }),
    );
    expect(sub.applicationFeeByLeaseType).toEqual({ "Month-to-Month": "25" });
    const untouched = normalizeManagerListingSubmissionV1(listing({ applicationFee: "50" }));
    expect(untouched.applicationFeeByLeaseType).toBeUndefined();
  });
});
