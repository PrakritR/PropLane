/**
 * Properties never opens the create-listing wizard by itself.
 *
 * Visiting the tab must stay on the requested stage and leave the wizard
 * closed. Add is the only door.
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
  it("never opens, even for a brand-new empty account", () => {
    expect(shouldAutoOpenFirstListingWizard({ snap: snap(), dismissed: false })).toBe(false);
  });

  it("never opens when a leftover draft exists", () => {
    expect(shouldAutoOpenFirstListingWizard({ snap: snap({ drafts: 1 }), dismissed: false })).toBe(false);
  });

  it("never opens for a listed, unlisted, or co-managed portfolio", () => {
    expect(shouldAutoOpenFirstListingWizard({ snap: snap({ listingSlots: 1 }), dismissed: false })).toBe(false);
    expect(shouldAutoOpenFirstListingWizard({ snap: snap({ unlisted: 1 }), dismissed: false })).toBe(false);
    expect(shouldAutoOpenFirstListingWizard({ snap: snap({ coManaged: 3 }), dismissed: false })).toBe(false);
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

describe("auto-open stays off regardless of leftover flags", () => {
  it("does not open when session or dismiss flags would have allowed it", () => {
    expect(
      shouldAutoOpenFirstListingWizard({ snap: snap({ drafts: 1 }), dismissed: false, autoOpenedThisSession: false }),
    ).toBe(false);
    expect(shouldAutoOpenFirstListingWizard({ snap: snap({ listed: 1 }), dismissed: false })).toBe(false);
  });
});
