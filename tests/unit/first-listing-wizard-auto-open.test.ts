/**
 * When Properties may open the create-listing wizard by itself.
 *
 * The rule the captain stated, and the two ways the old one broke it:
 * it reopened on every visit to Properties until a listing existed, so closing
 * it meant nothing; and it counted only OWNED rows, so a co-manager working
 * somebody else's portfolio was treated as a brand-new manager.
 */
import { describe, expect, it } from "vitest";
import {
  managerHasAnyListing,
  managerPortfolioNeedsFirstListingSeed,
  shouldAutoOpenFirstListingWizard,
  type FirstListingPortfolioSnapshot,
} from "@/lib/manager-first-listing-onboarding";

const snap = (over: Partial<FirstListingPortfolioSnapshot> = {}): FirstListingPortfolioSnapshot => ({
  listed: 0,
  listingSlots: 0,
  drafts: 0,
  unlisted: 0,
  coManaged: 0,
  ...over,
});

describe("what counts as having a listing", () => {
  it("counts owned, unlisted and co-managed properties", () => {
    expect(managerHasAnyListing(snap({ listingSlots: 1 }))).toBe(true);
    expect(managerHasAnyListing(snap({ unlisted: 1 }))).toBe(true);
    expect(managerHasAnyListing(snap({ coManaged: 1 }))).toBe(true);
  });

  it("does NOT count a draft — a draft is what the wizard makes", () => {
    expect(managerHasAnyListing(snap({ drafts: 3 }))).toBe(false);
  });
});

describe("auto-opening the create-listing wizard", () => {
  it("opens for a brand-new account with nothing at all", () => {
    expect(shouldAutoOpenFirstListingWizard({ snap: snap(), dismissed: false })).toBe(true);
  });

  it("never opens again once the manager has closed it", () => {
    expect(shouldAutoOpenFirstListingWizard({ snap: snap(), dismissed: true })).toBe(false);
  });

  it("does not open for a co-manager who has properties on somebody else's account", () => {
    // The reported bug: every listing this account works is co-managed, so the
    // owned count is zero and the wizard treated them as brand new.
    expect(shouldAutoOpenFirstListingWizard({ snap: snap({ coManaged: 3 }), dismissed: false })).toBe(false);
  });

  it("does not open for an account with a listed or unlisted property", () => {
    expect(shouldAutoOpenFirstListingWizard({ snap: snap({ listingSlots: 1 }), dismissed: false })).toBe(false);
    expect(shouldAutoOpenFirstListingWizard({ snap: snap({ unlisted: 1 }), dismissed: false })).toBe(false);
  });

  it("still opens when only an unfinished draft exists and it was never dismissed", () => {
    expect(shouldAutoOpenFirstListingWizard({ snap: snap({ drafts: 1 }), dismissed: false })).toBe(true);
  });
});

describe("seeding the first draft", () => {
  it("never seeds for a co-manager who already works real properties", () => {
    expect(managerPortfolioNeedsFirstListingSeed(snap({ coManaged: 2 }))).toBe(false);
  });

  it("seeds only for a genuinely empty portfolio", () => {
    expect(managerPortfolioNeedsFirstListingSeed(snap())).toBe(true);
    expect(managerPortfolioNeedsFirstListingSeed(snap({ drafts: 1 }))).toBe(false);
  });
});
