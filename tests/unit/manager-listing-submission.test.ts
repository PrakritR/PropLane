import { describe, expect, it } from "vitest";
import {
  applyEntireHomeListingPricing,
  applyEntireHomeMonthlyRent,
  createDefaultListingSubmission,
  createNewListingWizardSubmission,
  entireHomeMonthlyRentAmount,
  isEntireHomeListing,
  normalizeManagerListingSubmissionV1,
  resolveAllowedLeaseTerms,
  syncShortTermLeaseTermInAllowed,
} from "@/lib/manager-listing-submission";
import { sortLeaseTermsCanonical } from "@/lib/rental-application/lease-terms";

describe("lease term ordering — ascending length, Short-Term Stay, Custom last", () => {
  it("un-transposes 9-Month and 12-Month regardless of stored order", () => {
    // The exact production defect: a listing stored 12-Month before 9-Month.
    expect(sortLeaseTermsCanonical(["3-Month", "12-Month", "9-Month", "Month-to-Month", "Custom"])).toEqual([
      "3-Month",
      "9-Month",
      "12-Month",
      "Month-to-Month",
      "Custom",
    ]);
  });

  it("groups the lease shapes first, then the stay types", () => {
    expect(
      sortLeaseTermsCanonical(["Custom", "Short-Term Stay", "12-Month", "3-Month", "9-Month", "Month-to-Month"]),
    ).toEqual(["3-Month", "9-Month", "12-Month", "Month-to-Month", "Custom", "Short-Term Stay"]);
  });

  it("resolveAllowedLeaseTerms canonicalizes a listing's stored (mis)ordered terms", () => {
    const terms = resolveAllowedLeaseTerms({
      allowedLeaseTerms: ["12-Month", "3-Month", "Custom", "9-Month"],
      leaseTermsBody: "",
      shortTermRentalsAllowed: false,
    });
    expect(terms).toEqual(["3-Month", "9-Month", "12-Month", "Custom"]);
  });

  it("adds Short-Term Stay after Custom only when the listing permits it", () => {
    const withShort = syncShortTermLeaseTermInAllowed(["12-Month", "9-Month", "3-Month", "Custom"], true);
    expect(withShort).toEqual(["3-Month", "9-Month", "12-Month", "Custom", "Short-Term Stay"]);
    const withoutShort = syncShortTermLeaseTermInAllowed(["12-Month", "9-Month", "Short-Term Stay", "3-Month"], false);
    expect(withoutShort).toEqual(["3-Month", "9-Month", "12-Month"]);
  });
});

describe("manager-listing-submission", () => {
  it("normalizes minimal submission", () => {
    const sub = normalizeManagerListingSubmissionV1({
      v: 1,
      buildingName: "Test House",
      rooms: [],
      bathrooms: [],
      sharedSpaces: [],
      bundles: [],
      quickFacts: [],
    } as never);
    expect(sub.buildingName).toBe("Test House");
    expect(sub.rooms).toEqual([]);
  });

  it("detects entire-home listings and syncs one rent", () => {
    const base = createDefaultListingSubmission();
    const updated = applyEntireHomeMonthlyRent(
      {
        ...base,
        listingPlaceCategoryId: "entire_home",
        rooms: [
          { ...base.rooms[0]!, name: "Bedroom 1", monthlyRent: 900 },
          { ...base.rooms[1]!, name: "Bedroom 2", monthlyRent: 800 },
        ],
      },
      4500,
    );
    expect(isEntireHomeListing(updated)).toBe(true);
    expect(entireHomeMonthlyRentAmount(updated)).toBe(4500);
    expect(updated.rooms[0]?.monthlyRent).toBe(4500);
    expect(updated.rooms[1]?.monthlyRent).toBe(0);
  });

  it("clears entire-home rent without falling back to per-room rent", () => {
    const base = createDefaultListingSubmission();
    const seeded = applyEntireHomeMonthlyRent(
      {
        ...base,
        listingPlaceCategoryId: "entire_home",
        rooms: [{ ...base.rooms[0]!, name: "Bedroom 1", monthlyRent: 1 }],
      },
      4500,
    );
    const cleared = applyEntireHomeListingPricing(seeded, { entireHomeMonthlyRent: 0 });
    expect(cleared.entireHomeMonthlyRent).toBe(0);
    expect(cleared.rooms[0]?.monthlyRent).toBe(0);
    expect(entireHomeMonthlyRentAmount(cleared)).toBe(0);
  });

  it("clears lease bundles when switching to entire-home pricing", () => {
    const base = createDefaultListingSubmission();
    const withBundles = {
      ...base,
      listingPlaceCategoryId: "shared_home" as const,
      bundles: [
        {
          id: "bundle-1",
          label: "Whole house lease",
          price: "$4500/mo",
          strikethrough: "",
          promo: "",
          roomsLine: "",
          includedRoomIds: [base.rooms[0]!.id],
        },
      ],
    };
    const entireHome = applyEntireHomeListingPricing(withBundles, { entireHomeMonthlyRent: 4500 });
    expect(entireHome.bundles).toEqual([]);
    expect(
      normalizeManagerListingSubmissionV1({
        ...withBundles,
        listingPlaceCategoryId: "entire_home",
        entireHomeMonthlyRent: 4500,
      }).bundles,
    ).toEqual([]);
  });

  it("re-tags a legacy untagged fee row from its label so the Fees table stops showing it twice", () => {
    // An existing listing whose customFees mix a unified (tagged) row with a legacy row
    // that was stripped to {id,label,amount} — the shape that caused a preset to render
    // once as its standard row and again as a custom row on an existing listing.
    const sub = normalizeManagerListingSubmissionV1({
      ...createDefaultListingSubmission(),
      customFees: [
        { id: "fee-tagged", label: "Move-in fee", amount: "250", frequency: "one-time", presetId: "move_in_fee" },
        // legacy: no presetId, label matches the security-deposit preset's default label
        { id: "fee-legacy", label: "Security deposit", amount: "1100", frequency: "one-time" },
        // a genuinely custom row must stay custom
        { id: "fee-custom", label: "Pet rent", amount: "40", frequency: "monthly" },
      ],
    } as Parameters<typeof normalizeManagerListingSubmissionV1>[0]);

    const byId = (id: string) => (sub.customFees ?? []).find((f) => f.id === id) as { presetId?: string } | undefined;
    // The legacy row is recovered as the security_deposit preset → the Fees table's
    // `!presetId || presetId === "custom"` filter excludes it, so no duplicate row.
    expect(byId("fee-legacy")?.presetId).toBe("security_deposit");
    expect(byId("fee-tagged")?.presetId).toBe("move_in_fee");
    // A row that matches no preset label stays custom.
    expect(byId("fee-custom")?.presetId).toBe("custom");
  });

  it("normalizes shared space kind from name when missing", () => {
    const sub = normalizeManagerListingSubmissionV1({
      ...createDefaultListingSubmission(),
      sharedSpaces: [
        {
          id: "ss-1",
          name: "Laundry room",
          location: "",
          detail: "",
          amenitiesText: "",
          photoDataUrls: [],
          videoDataUrl: null,
          roomAccessIds: [],
        },
      ],
    });
    expect(sub.sharedSpaces[0]?.spaceKind).toBe("laundry");
  });

  it("preserves a shared space's sizeSqft and drops a non-numeric one (PRP-481)", () => {
    const sub = normalizeManagerListingSubmissionV1({
      ...createDefaultListingSubmission(),
      sharedSpaces: [
        {
          id: "ss-1",
          name: "Kitchen",
          location: "",
          detail: "",
          amenitiesText: "",
          photoDataUrls: [],
          videoDataUrl: null,
          roomAccessIds: [],
          sizeSqft: 180,
        },
        {
          id: "ss-2",
          name: "Laundry room",
          location: "",
          detail: "",
          amenitiesText: "",
          photoDataUrls: [],
          videoDataUrl: null,
          roomAccessIds: [],
          sizeSqft: "not a number" as unknown as number,
        },
      ],
    });
    expect(sub.sharedSpaces[0]?.sizeSqft).toBe(180);
    expect(sub.sharedSpaces[1]?.sizeSqft).toBeUndefined();
  });

  it("creates default submission with one empty room row", () => {
    const sub = createDefaultListingSubmission();
    expect(sub.v).toBe(1);
    expect(sub.listingPlaceCategoryId).toBe("shared_home");
    expect(sub.rooms).toHaveLength(1);
    expect(sub.rooms[0]?.name).toBe("");
  });

  it("resolves lease terms from body text when array is empty", () => {
    const sub = createDefaultListingSubmission();
    sub.allowedLeaseTerms = [];
    sub.leaseTermsBody = "Available lease lengths: 12-Month, Month-to-Month.";
    expect(resolveAllowedLeaseTerms(sub)).toEqual(expect.arrayContaining(["12-Month", "Month-to-Month"]));
  });

  describe("holdingDepositTiming — manager's per-listing pay-at-application choice", () => {
    it("defaults new listings to after_approval (unchanged legacy behavior)", () => {
      expect(createDefaultListingSubmission().holdingDepositTiming).toBe("after_approval");
    });

    it("defaults an existing listing with no setting stored to after_approval", () => {
      const sub = normalizeManagerListingSubmissionV1({
        ...createDefaultListingSubmission(),
      } as never);
      expect(sub.holdingDepositTiming).toBe("after_approval");
    });

    it("preserves an explicit at_application choice through normalization", () => {
      const sub = normalizeManagerListingSubmissionV1({
        ...createDefaultListingSubmission(),
        holdingDepositTiming: "at_application",
      } as never);
      expect(sub.holdingDepositTiming).toBe("at_application");
    });

    it("rejects an invalid value and falls back to after_approval", () => {
      const sub = normalizeManagerListingSubmissionV1({
        ...createDefaultListingSubmission(),
        holdingDepositTiming: "sometime-later",
      } as never);
      expect(sub.holdingDepositTiming).toBe("after_approval");
    });
  });
});

describe("disclosure trigger fields", () => {
  const norm = (patch: Record<string, unknown>) =>
    normalizeManagerListingSubmissionV1({ ...createDefaultListingSubmission(), ...patch } as never);

  it("leaves every trigger absent on a legacy submission that never had them", () => {
    const sub = norm({});
    // Absent, never a guessed value: a defaulted yearBuilt would make an
    // unknown-age building read as post-1978 and suppress the lead-paint rule.
    expect(sub.yearBuilt).toBeUndefined();
    expect(sub.sharedUtilityMetering).toBeUndefined();
    expect(sub.hasPeriodicPestService).toBeUndefined();
    expect(sub.certificateOfOccupancyDate).toBeUndefined();
    expect(sub.rrioRegistrationNumber).toBeUndefined();
    // Nothing new is written into stored JSON for an existing listing.
    expect(JSON.parse(JSON.stringify(sub))).not.toHaveProperty("yearBuilt");
  });

  it("keeps a real pre-1978 year and drops junk rather than guessing", () => {
    expect(norm({ yearBuilt: 1962 }).yearBuilt).toBe(1962);
    expect(norm({ yearBuilt: "1962" }).yearBuilt).toBe(1962);
    expect(norm({ yearBuilt: 19 }).yearBuilt).toBeUndefined();
    expect(norm({ yearBuilt: 1977.5 }).yearBuilt).toBeUndefined();
    expect(norm({ yearBuilt: "not a year" }).yearBuilt).toBeUndefined();
  });

  it("only records an affirmatively checked boolean", () => {
    expect(norm({ sharedUtilityMetering: true }).sharedUtilityMetering).toBe(true);
    expect(norm({ sharedUtilityMetering: false }).sharedUtilityMetering).toBeUndefined();
    expect(norm({ hasPeriodicPestService: true }).hasPeriodicPestService).toBe(true);
    expect(norm({ hasPeriodicPestService: false }).hasPeriodicPestService).toBeUndefined();
  });

  it("keeps an ISO occupancy date and a trimmed RRIO number", () => {
    expect(norm({ certificateOfOccupancyDate: "1978-06-01" }).certificateOfOccupancyDate).toBe("1978-06-01");
    expect(norm({ certificateOfOccupancyDate: "06/01/1978" }).certificateOfOccupancyDate).toBeUndefined();
    // Right shape, impossible calendar date — the rules engine must never read one.
    expect(norm({ certificateOfOccupancyDate: "9999-99-99" }).certificateOfOccupancyDate).toBeUndefined();
    expect(norm({ certificateOfOccupancyDate: "1978-02-30" }).certificateOfOccupancyDate).toBeUndefined();
    expect(norm({ rrioRegistrationNumber: "  RRIO-123456 " }).rrioRegistrationNumber).toBe("RRIO-123456");
    expect(norm({ rrioRegistrationNumber: "   " }).rrioRegistrationNumber).toBeUndefined();
  });
});

describe("createNewListingWizardSubmission — pre-filled new-listing defaults", () => {
  it("pre-selects a 12-Month lease so the common case publishes with minimal typing", () => {
    expect(createNewListingWizardSubmission().allowedLeaseTerms).toEqual(["12-Month"]);
  });
  it("starts with only application fee in Other fees (other standard rows are removed)", () => {
    const sub = createNewListingWizardSubmission();
    expect(sub.removedStandardListingFeeRows).toContain("parkingMonthly");
    expect(sub.removedStandardListingFeeRows).not.toContain("applicationFee");
    expect(sub.holdingDeposit).toBe("");
  });
  it("does not change the blank base used by tests / back-compat", () => {
    expect(createDefaultListingSubmission().allowedLeaseTerms).toEqual([]);
  });
});
