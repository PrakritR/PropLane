import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/demo/demo-session", () => ({
  isDemoModeActive: vi.fn(() => false),
  resolveManagerScopeUserId: (id: string | null) => id,
}));

vi.mock("@/lib/portal-sandbox-accounts", () => ({
  isPortalSandboxEmail: (email: string | null | undefined) =>
    Boolean(email?.endsWith("@test.proplane.local")),
}));

vi.mock("@/lib/demo-admin-property-inventory", async () => {
  const actual = await vi.importActual<typeof import("@/lib/demo-admin-property-inventory")>(
    "@/lib/demo-admin-property-inventory",
  );
  return {
    ...actual,
    saveManagerPropertyDraftToServer: vi.fn(async () => "mgr-listing-seeded1"),
  };
});

import { isDemoModeActive } from "@/lib/demo/demo-session";
import { saveManagerPropertyDraftToServer } from "@/lib/demo-admin-property-inventory";
import {
  ensureManagerFirstListingDraft,
  managerNeedsFirstListingOnboarding,
  managerPortfolioNeedsFirstListingSeed,
  shouldAutoOpenFirstListingWizard,
  shouldSkipFirstListingOnboarding,
} from "@/lib/manager-first-listing-onboarding";

describe("manager-first-listing-onboarding (PRP-396)", () => {
  beforeEach(() => {
    vi.mocked(isDemoModeActive).mockReturnValue(false);
    vi.mocked(saveManagerPropertyDraftToServer).mockClear();
    vi.mocked(saveManagerPropertyDraftToServer).mockResolvedValue("mgr-listing-seeded1");
  });

  it("needs seed only when slots, drafts, and unlisted are all zero", () => {
    expect(managerPortfolioNeedsFirstListingSeed({ listed: 0, listingSlots: 0, drafts: 0, unlisted: 0, coManaged: 0 })).toBe(
      true,
    );
    expect(managerPortfolioNeedsFirstListingSeed({ listed: 0, listingSlots: 0, drafts: 1, unlisted: 0, coManaged: 0 })).toBe(
      false,
    );
    expect(managerPortfolioNeedsFirstListingSeed({ listed: 0, listingSlots: 1, drafts: 0, unlisted: 0, coManaged: 0 })).toBe(
      false,
    );
    expect(managerPortfolioNeedsFirstListingSeed({ listed: 0, listingSlots: 0, drafts: 0, unlisted: 1, coManaged: 0 })).toBe(
      false,
    );
  });

  it("needs soft onboarding when a draft exists but no listing slot yet", () => {
    expect(managerNeedsFirstListingOnboarding({ listed: 0, listingSlots: 0, drafts: 1, unlisted: 0, coManaged: 0 })).toBe(
      true,
    );
    expect(managerNeedsFirstListingOnboarding({ listed: 0, listingSlots: 1, drafts: 1, unlisted: 0, coManaged: 0 })).toBe(
      false,
    );
    expect(managerNeedsFirstListingOnboarding({ listed: 0, listingSlots: 0, drafts: 1, unlisted: 1, coManaged: 0 })).toBe(
      false,
    );
  });

  it("skips demo and sandbox emails", () => {
    expect(shouldSkipFirstListingOnboarding({ demo: true })).toBe(true);
    expect(shouldSkipFirstListingOnboarding({ email: "manager@test.proplane.local" })).toBe(true);
    expect(shouldSkipFirstListingOnboarding({ email: "owner@prop-lane.space" })).toBe(false);
  });

  it("seeds once when the portfolio is empty AND the sync confirmed it", async () => {
    // Empty local snapshot: adminKpiCounts / count helpers read real local store.
    // Use a throwaway user id unlikely to have residual side buckets in this process.
    const userId = `mgr-first-listing-test-${Date.now()}`;
    const result = await ensureManagerFirstListingDraft(userId, {
      email: "fresh@prop-lane.space",
      portfolioSynced: true,
    });
    expect(result).toEqual({ draftId: "mgr-listing-seeded1", created: true });
    expect(saveManagerPropertyDraftToServer).toHaveBeenCalledTimes(1);
  });

  // PRP-429: an established account got a phantom "Property · New listing" draft
  // because a failed/pending portfolio sync leaves the same empty local snapshot
  // a brand-new account has. Unloaded is not empty.
  it("refuses to seed when the portfolio sync did not land", async () => {
    const userId = `mgr-unsynced-test-${Date.now()}`;
    expect(
      await ensureManagerFirstListingDraft(userId, {
        email: "established@prop-lane.space",
        portfolioSynced: false,
      }),
    ).toBeNull();
    expect(
      await ensureManagerFirstListingDraft(`${userId}-b`, {
        email: "established@prop-lane.space",
      }),
    ).toBeNull();
    expect(saveManagerPropertyDraftToServer).not.toHaveBeenCalled();
  });

  it("does not seed for sandbox accounts", async () => {
    const result = await ensureManagerFirstListingDraft("any-user", {
      email: "manager@test.proplane.local",
    });
    expect(result).toBeNull();
    expect(saveManagerPropertyDraftToServer).not.toHaveBeenCalled();
  });
});

describe("co-manager links must be KNOWN before a draft is seeded", () => {
  /*
    The reported bug: an account co-managing three properties on somebody
    else's portfolio got a fresh draft minted on every visit to Properties.
    Nothing it owns says otherwise, and the link cache reads `[]` both before
    it loads and when there genuinely are none — so "empty portfolio" was being
    decided on a question that had not been answered yet.
  */
  const EMPTY = { listed: 0, listingSlots: 0, drafts: 0, unlisted: 0, coManaged: 0 };

  it("does not auto-open the wizard while the link answer is outstanding", () => {
    expect(
      shouldAutoOpenFirstListingWizard({ snap: EMPTY, dismissed: false, coManagerLinksKnown: false }),
    ).toBe(false);
  });

  it("still opens for a genuinely empty account once the links are known", () => {
    expect(
      shouldAutoOpenFirstListingWizard({ snap: EMPTY, dismissed: false, coManagerLinksKnown: true }),
    ).toBe(true);
  });

  it("never opens when the Listed tab has anything in it", () => {
    // The captain's rule, in his words: only when there are NO properties
    // listed. This is read from the very counter the tab renders.
    expect(
      shouldAutoOpenFirstListingWizard({
        snap: { ...EMPTY, listed: 3 },
        dismissed: false,
        coManagerLinksKnown: true,
      }),
    ).toBe(false);
    expect(managerPortfolioNeedsFirstListingSeed({ ...EMPTY, listed: 3 })).toBe(false);
  });

  it("never opens once the account co-manages anything", () => {
    expect(
      shouldAutoOpenFirstListingWizard({
        snap: { ...EMPTY, coManaged: 3 },
        dismissed: false,
        coManagerLinksKnown: true,
      }),
    ).toBe(false);
  });

  it("treats an omitted flag as known, so existing callers are unchanged", () => {
    expect(shouldAutoOpenFirstListingWizard({ snap: EMPTY, dismissed: false })).toBe(true);
  });
});
