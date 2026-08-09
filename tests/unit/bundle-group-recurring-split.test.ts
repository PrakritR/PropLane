/**
 * @vitest-environment jsdom
 *
 * Regression: a bundle-group roommate's RECURRING months must be divided the
 * same way their move-in charges were.
 *
 * `recordApprovedApplicationCharges` split the upfront charges through
 * `applyBundleGroupSplit` but wrote the recurring profile with the UNSPLIT
 * household total (`selectedRoomRentAmount` returns the bundle's full amount),
 * and the recurring generator applied no split at all. So a 3-person group on a
 * $2,400/mo bundle was billed a correct $800 each at move-in and then $2,400
 * EACH, every month after — $7,200/month against a $2,400 household, dunned and
 * late-feed like any other balance. Utilities and monthly fees had the identical
 * defect.
 *
 * These drive the real generator: `writeRentProfiles` runs
 * `syncAllRecurringRentCharges`, so upserting a profile emits its charges.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  readHouseholdCharges,
  removeResidentHouseholdPaymentData,
  upsertRecurringRentProfile,
} from "@/lib/household-charges";

const MANAGER_ID = "mgr-bundle-split";
const PROPERTY_ID = "prop-bundle-split";

/** Far enough back that several full recurring months have been generated. */
const START_MONTH = "2026-04";

type ProfileOverrides = Parameters<typeof upsertRecurringRentProfile>[0];

function seedProfile(email: string, over: Partial<ProfileOverrides> = {}) {
  return upsertRecurringRentProfile({
    residentEmail: email,
    residentName: "Roommate",
    propertyId: PROPERTY_ID,
    propertyLabel: "Bundle House",
    roomLabel: "Whole house",
    managerUserId: MANAGER_ID,
    monthlyRent: 2400,
    monthlyUtilities: 150,
    monthlyFees: [{ id: "parking", label: "Parking", amount: 90 }],
    dueDay: 1,
    startMonth: START_MONTH,
    ...over,
  });
}

function chargesFor(email: string, kind: string) {
  return readHouseholdCharges()
    .filter((c) => c.residentEmail.toLowerCase() === email.toLowerCase())
    .filter((c) => c.kind === kind)
    .sort((a, b) => (a.rentMonth ?? "").localeCompare(b.rentMonth ?? ""));
}

beforeEach(() => {
  window.sessionStorage.clear();
});

describe("bundle-group recurring charges", () => {
  it("divides every recurring month by the member count, not just move-in", () => {
    const email = "roommate-a@example.com";
    removeResidentHouseholdPaymentData(email);

    seedProfile(email, {
      bundleGroupId: "AXISGRP-BUNDLE1",
      bundleId: "bundle-1",
      splitMemberIndex: 0,
      splitMemberCount: 3,
    });

    const rent = chargesFor(email, "rent");
    expect(rent.length).toBeGreaterThan(0);

    // $2,400 household ÷ 3 = $800.00 each, EVERY month — not $2,400 each.
    for (const charge of rent) {
      expect(charge.amountLabel).toBe("$800.00");
      expect(charge.splitMemberCount).toBe(3);
      expect(charge.bundleGroupId).toBe("AXISGRP-BUNDLE1");
      // The title states the share so the resident can see what they are paying
      // a third OF, matching the move-in charges' wording.
      expect(charge.title).toContain("your 1/3 share of $2400");
    }

    // Utilities split the same way: $150 ÷ 3 = $50.00.
    for (const charge of chargesFor(email, "utilities")) {
      expect(charge.amountLabel).toBe("$50.00");
    }

    // Monthly custom fees too: $90 ÷ 3 = $30.00.
    for (const charge of chargesFor(email, "other_cost")) {
      expect(charge.amountLabel).toBe("$30.00");
    }
  });

  it("leaves an ordinary (non-bundle) profile billing the full amount", () => {
    const email = "solo-tenant@example.com";
    removeResidentHouseholdPaymentData(email);

    seedProfile(email);

    const rent = chargesFor(email, "rent");
    expect(rent.length).toBeGreaterThan(0);
    for (const charge of rent) {
      expect(charge.amountLabel).toBe("$2,400.00");
      expect(charge.splitMemberCount).toBeUndefined();
      // No "(1/3 of …)" share suffix on a profile with no split.
      expect(charge.title).not.toContain(" of ");
    }
    for (const charge of chargesFor(email, "utilities")) {
      expect(charge.amountLabel).toBe("$150.00");
    }
    for (const charge of chargesFor(email, "other_cost")) {
      expect(charge.amountLabel).toBe("$90.00");
    }
  });

  it("ignores a malformed split rather than billing a member zero", () => {
    const email = "roommate-bad@example.com";
    removeResidentHouseholdPaymentData(email);

    // memberIndex outside memberCount is the over-subscribed-group shape;
    // `splitMoneyEvenly` returns 0 for it, which would move a resident in with
    // an empty ledger. Falling back to the full amount is visible and
    // correctable; a silent $0 is neither.
    seedProfile(email, {
      bundleGroupId: "AXISGRP-BUNDLE2",
      bundleId: "bundle-2",
      splitMemberIndex: 3,
      splitMemberCount: 3,
    });

    for (const charge of chargesFor(email, "rent")) {
      expect(charge.amountLabel).toBe("$2,400.00");
    }
  });
});
