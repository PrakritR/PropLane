import { beforeEach, describe, expect, it, vi } from "vitest";

const trackMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/analytics/posthog", () => ({ track: trackMock }));

import {
  finalizePendingManagerFreeTier,
  newAxisPendingSessionId,
} from "@/lib/auth/manager-onboarding";

type Purchase = {
  id: string;
  email: string;
  manager_id: string;
  tier: string | null;
  billing: string | null;
  stripe_checkout_session_id: string;
  user_id: string | null;
  full_name: string | null;
  paid_at: string | null;
};

/** Minimal Supabase stub: one manager_purchases row, select chain + update chain. */
function fakeDb(purchase: Purchase, updateError: Error | null = null) {
  const lookup = {
    eq: () => lookup,
    order: () => lookup,
    limit: () => lookup,
    maybeSingle: async () => ({ data: purchase }),
  };
  return {
    from: () => ({
      select: () => lookup,
      update: () => ({ eq: async () => ({ error: updateError }) }),
    }),
  } as never;
}

const pending: Purchase = {
  id: "p1",
  email: "m@example.com",
  manager_id: "AXIS-100",
  tier: null,
  billing: null,
  stripe_checkout_session_id: newAxisPendingSessionId(),
  user_id: "user-1",
  full_name: null,
  paid_at: null,
};

describe("manager_account_created analytics", () => {
  beforeEach(() => trackMock.mockClear());

  it("fires once when a pending manager account is finalized as a trial", async () => {
    await finalizePendingManagerFreeTier(fakeDb(pending), {
      userId: "user-1",
      email: "m@example.com",
      tier: "pro",
      billing: "trial",
    });
    expect(trackMock).toHaveBeenCalledTimes(1);
    expect(trackMock).toHaveBeenCalledWith("manager_account_created", "user-1", {
      manager_id: "AXIS-100",
      signup_method: "trial",
      tier: "pro",
      billing: "trial",
    });
  });

  it("labels a free-tier finalize as free_tier", async () => {
    await finalizePendingManagerFreeTier(fakeDb(pending), {
      userId: "user-1",
      email: "m@example.com",
      tier: "free",
      billing: "monthly",
    });
    expect(trackMock.mock.calls[0]?.[2]).toMatchObject({ signup_method: "free_tier", tier: "free" });
  });

  it("does not fire again for an already-complete onboarding", async () => {
    const complete: Purchase = {
      ...pending,
      tier: "free",
      billing: "monthly",
      stripe_checkout_session_id: "axis_intent_abc",
      paid_at: "2026-10-01T00:00:00Z",
    };
    await finalizePendingManagerFreeTier(fakeDb(complete), {
      userId: "user-1",
      email: "m@example.com",
      tier: "free",
      billing: "monthly",
    });
    expect(trackMock).not.toHaveBeenCalled();
  });

  it("does not fire when the purchase update fails", async () => {
    await expect(
      finalizePendingManagerFreeTier(fakeDb(pending, new Error("db down")), {
        userId: "user-1",
        email: "m@example.com",
        tier: "free",
        billing: "monthly",
      }),
    ).rejects.toThrow("db down");
    expect(trackMock).not.toHaveBeenCalled();
  });
});
