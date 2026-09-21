import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: vi.fn(),
}));
vi.mock("@/lib/test-workspaces/effects.server", () => ({
  captureTestWorkspaceEffectForUser: vi.fn().mockResolvedValue({ captured: false }),
}));

import {
  checkoutSessionIndicatesPaidPurchase,
  recordPaidManagerCheckoutSession,
  resolveManagerCheckoutPurchase,
} from "@/lib/manager-purchase-from-session";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { mockCheckoutSession } from "../mocks/stripe/events";

describe("manager-purchase-from-session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("detects paid checkout sessions", () => {
    expect(checkoutSessionIndicatesPaidPurchase(mockCheckoutSession())).toBe(true);
    expect(checkoutSessionIndicatesPaidPurchase(mockCheckoutSession({ payment_status: "unpaid", status: "open" }))).toBe(
      false,
    );
  });

  it("accepts completed subscription with unpaid payment status", () => {
    expect(
      checkoutSessionIndicatesPaidPurchase(
        mockCheckoutSession({ payment_status: "unpaid", status: "complete", mode: "subscription" }),
      ),
    ).toBe(true);
  });

  it("fulfills a durable guest reservation without inventing an auth owner", async () => {
    const update = vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ error: null }) }));
    const query = {
      eq: vi.fn(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: { id: "purchase-1", user_id: null, manager_id: "MGR-TEST", email: "manager@example.com" },
        error: null,
      }),
    };
    query.eq.mockReturnValue(query);
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({
      from: vi.fn(() => ({ select: vi.fn(() => query), update })),
    } as never);

    await recordPaidManagerCheckoutSession(
      mockCheckoutSession({
        id: "cs_test_guest",
        customer_email: "manager@example.com",
        metadata: { tier: "pro", billing: "monthly", manager_id: "MGR-TEST" },
      }),
    );

    expect(update).toHaveBeenCalledWith(expect.not.objectContaining({ user_id: expect.anything() }));
  });

  it("does not let signed metadata replace a reservation's auth owner", async () => {
    const update = vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ error: null }) }));
    const query = {
      eq: vi.fn(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: { id: "purchase-1", user_id: "owner-a", manager_id: "MGR-TEST", email: "manager@example.com" },
        error: null,
      }),
    };
    query.eq.mockReturnValue(query);
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({
      from: vi.fn(() => ({ select: vi.fn(() => query), update })),
    } as never);

    await expect(
      recordPaidManagerCheckoutSession(
        mockCheckoutSession({
          id: "cs_test_mismatch",
          customer_email: "manager@example.com",
          metadata: { tier: "pro", billing: "monthly", manager_id: "MGR-TEST", userId: "owner-b" },
        }),
      ),
    ).rejects.toThrow("ownership");
    expect(update).not.toHaveBeenCalled();
  });

  it("resolves an authenticated legacy session from its durable pending owner", async () => {
    const responses = [
      { data: null, error: null },
      { data: { id: "purchase-legacy", user_id: "owner-a", manager_id: "MGR-A", email: "a@example.com" }, error: null },
    ];
    const query = {
      select: vi.fn(),
      eq: vi.fn(),
      or: vi.fn(),
      maybeSingle: vi.fn(async () => responses.shift()),
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.or.mockReturnValue(query);
    const db = { from: vi.fn(() => query) } as never;

    await expect(resolveManagerCheckoutPurchase(db, mockCheckoutSession({
      id: "cs_legacy_auth",
      customer_email: "a@example.com",
      metadata: { tier: "pro", billing: "monthly", manager_id: "MGR-A", userId: "owner-a" },
    }))).resolves.toMatchObject({ id: "purchase-legacy", userId: "owner-a" });
    expect(query.eq).toHaveBeenNthCalledWith(1, "stripe_checkout_session_id", "cs_legacy_auth");
    expect(query.eq).toHaveBeenNthCalledWith(2, "user_id", "owner-a");
  });

  it("resolves a guest legacy session only when pending manager and email both match", async () => {
    const responses = [
      { data: null, error: null },
      { data: { id: "purchase-guest", user_id: null, manager_id: "MGR-G", email: "guest@example.com" }, error: null },
    ];
    const query = {
      select: vi.fn(),
      eq: vi.fn(),
      or: vi.fn(),
      maybeSingle: vi.fn(async () => responses.shift()),
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.or.mockReturnValue(query);
    const db = { from: vi.fn(() => query) } as never;

    await expect(resolveManagerCheckoutPurchase(db, mockCheckoutSession({
      id: "cs_legacy_guest",
      customer_email: "guest@example.com",
      metadata: { tier: "pro", billing: "monthly", manager_id: "MGR-G" },
    }))).resolves.toMatchObject({ id: "purchase-guest", userId: null });
  });

  it("rejects a legacy guest whose signed email does not match the pending row", async () => {
    const responses = [
      { data: null, error: null },
      { data: { id: "purchase-guest", user_id: null, manager_id: "MGR-G", email: "stored@example.com" }, error: null },
    ];
    const query = {
      select: vi.fn(), eq: vi.fn(), or: vi.fn(), maybeSingle: vi.fn(async () => responses.shift()),
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.or.mockReturnValue(query);

    await expect(resolveManagerCheckoutPurchase({ from: vi.fn(() => query) } as never, mockCheckoutSession({
      id: "cs_legacy_guest_mismatch",
      customer_email: "attacker@example.com",
      metadata: { tier: "pro", billing: "monthly", manager_id: "MGR-G" },
    }))).rejects.toThrow("ownership");
  });
});
