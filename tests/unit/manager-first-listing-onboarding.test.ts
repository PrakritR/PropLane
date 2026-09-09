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
  shouldSkipFirstListingOnboarding,
} from "@/lib/manager-first-listing-onboarding";

describe("manager-first-listing-onboarding (PRP-396)", () => {
  beforeEach(() => {
    vi.mocked(isDemoModeActive).mockReturnValue(false);
    vi.mocked(saveManagerPropertyDraftToServer).mockClear();
    vi.mocked(saveManagerPropertyDraftToServer).mockResolvedValue("mgr-listing-seeded1");
  });

  it("needs seed only when slots, drafts, and unlisted are all zero", () => {
    expect(managerPortfolioNeedsFirstListingSeed({ listingSlots: 0, drafts: 0, unlisted: 0, coManaged: 0 })).toBe(
      true,
    );
    expect(managerPortfolioNeedsFirstListingSeed({ listingSlots: 0, drafts: 1, unlisted: 0, coManaged: 0 })).toBe(
      false,
    );
    expect(managerPortfolioNeedsFirstListingSeed({ listingSlots: 1, drafts: 0, unlisted: 0, coManaged: 0 })).toBe(
      false,
    );
    expect(managerPortfolioNeedsFirstListingSeed({ listingSlots: 0, drafts: 0, unlisted: 1, coManaged: 0 })).toBe(
      false,
    );
  });

  it("needs soft onboarding when a draft exists but no listing slot yet", () => {
    expect(managerNeedsFirstListingOnboarding({ listingSlots: 0, drafts: 1, unlisted: 0, coManaged: 0 })).toBe(
      true,
    );
    expect(managerNeedsFirstListingOnboarding({ listingSlots: 1, drafts: 1, unlisted: 0, coManaged: 0 })).toBe(
      false,
    );
    expect(managerNeedsFirstListingOnboarding({ listingSlots: 0, drafts: 1, unlisted: 1, coManaged: 0 })).toBe(
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
