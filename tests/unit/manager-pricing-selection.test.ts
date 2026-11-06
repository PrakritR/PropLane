import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  completeFreeManagerTierForUser,
  ensureProvisionedManagerForPricing,
  resolveManagerPurchaseForPricing,
} from "@/lib/auth/manager-pricing-selection";
import { newAxisPendingSessionId } from "@/lib/auth/manager-onboarding";

vi.mock("@/lib/auth/manager-onboarding", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/manager-onboarding")>();
  return {
    ...actual,
    findManagerPurchaseForAccount: vi.fn(),
    provisionPendingManagerAccount: vi.fn(),
    finalizePendingManagerFreeTier: vi.fn(),
  };
});

import {
  findManagerPurchaseForAccount,
  provisionPendingManagerAccount,
  finalizePendingManagerFreeTier,
} from "@/lib/auth/manager-onboarding";

describe("manager-pricing-selection", () => {
  const supabase = {} as never;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("treats abandoned Stripe checkout rows as pending for reuse", async () => {
    vi.mocked(findManagerPurchaseForAccount).mockResolvedValue({
      id: "purchase-1",
      email: "mgr@test.com",
      manager_id: "AXIS-EXISTING",
      tier: "pro",
      billing: "monthly",
      stripe_checkout_session_id: "cs_test_abandoned",
      user_id: "user-1",
      paid_at: null,
    });

    const state = await resolveManagerPurchaseForPricing(supabase, "user-1", "mgr@test.com");
    expect(state).toEqual({
      kind: "pending",
      managerId: "AXIS-EXISTING",
      purchaseId: "purchase-1",
    });
  });

  it("provisions profile and purchase when signed-in user has no row", async () => {
    vi.mocked(findManagerPurchaseForAccount).mockResolvedValue(null);
    vi.mocked(provisionPendingManagerAccount).mockResolvedValue({ managerId: "AXIS-NEW", created: true });

    const prepared = await ensureProvisionedManagerForPricing(supabase, {
      userId: "user-1",
      email: "new@test.com",
      fullName: "New Manager",
    });

    expect(prepared).toEqual({ kind: "ready", managerId: "AXIS-NEW" });
    expect(provisionPendingManagerAccount).toHaveBeenCalledWith(supabase, {
      userId: "user-1",
      email: "new@test.com",
      fullName: "New Manager",
    });
  });

  it("links free tier through provision + finalize instead of orphan insert", async () => {
    vi.mocked(findManagerPurchaseForAccount)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "purchase-1",
        email: "free@test.com",
        manager_id: "AXIS-FREE",
        tier: null,
        billing: null,
        stripe_checkout_session_id: newAxisPendingSessionId(),
        user_id: "user-1",
        paid_at: null,
      });
    vi.mocked(provisionPendingManagerAccount).mockResolvedValue({ managerId: "AXIS-FREE", created: true });
    vi.mocked(finalizePendingManagerFreeTier).mockResolvedValue({
      status: "finalized",
      sessionId: "axis_intent_test",
      managerId: "AXIS-FREE",
    });

    const result = await completeFreeManagerTierForUser(supabase, {
      userId: "user-1",
      email: "free@test.com",
      fullName: "Free Manager",
      tier: "free",
      billing: "monthly",
    });

    expect(result).toEqual({ managerId: "AXIS-FREE", alreadyLinked: true });
    expect(provisionPendingManagerAccount).toHaveBeenCalled();
    expect(finalizePendingManagerFreeTier).toHaveBeenCalled();
  });
});
