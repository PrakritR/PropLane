import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ session: {} as Record<string, unknown> }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: vi.fn(async () => ({
  auth: { getUser: async () => ({ data: { user: { id: "owner-a" } } }) },
})) }));
vi.mock("@/lib/stripe", () => ({ getStripe: vi.fn(() => ({ checkout: { sessions: {
  retrieve: vi.fn(async () => state.session),
} } })) }));
vi.mock("@/lib/manager-purchase-from-session", () => ({
  checkoutSessionIndicatesPaidPurchase: vi.fn((session: { payment_status?: string }) => session.payment_status === "paid"),
  adoptPaidPortalCheckoutForOwner: vi.fn().mockResolvedValue(undefined),
  recordPaidManagerCheckoutSession: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/manager-stripe-subscription-sync", () => ({
  reconcileManagerPurchaseWithStripe: vi.fn().mockResolvedValue(undefined),
}));

import { POST } from "@/app/api/stripe/confirm-checkout-session/route";
import { adoptPaidPortalCheckoutForOwner, recordPaidManagerCheckoutSession } from "@/lib/manager-purchase-from-session";

describe("manager checkout confirm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.session = { id: "cs_owned", client_reference_id: "owner-a", metadata: { userId: "owner-a" }, payment_status: "unpaid" };
  });

  const request = () => new Request("http://localhost/api/stripe/confirm-checkout-session", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: "cs_owned" }),
  });

  it("keeps completed but unpaid subscription pending without granting tier", async () => {
    const response = await POST(request());
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ processing: true });
    expect(adoptPaidPortalCheckoutForOwner).not.toHaveBeenCalled();
    expect(recordPaidManagerCheckoutSession).not.toHaveBeenCalled();
  });

  it("binds an actually paid owned session before fulfillment", async () => {
    state.session.payment_status = "paid";
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(adoptPaidPortalCheckoutForOwner).toHaveBeenCalledWith(state.session, "owner-a");
    expect(recordPaidManagerCheckoutSession).toHaveBeenCalledWith(state.session);
    expect(vi.mocked(adoptPaidPortalCheckoutForOwner).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(recordPaidManagerCheckoutSession).mock.invocationCallOrder[0]!,
    );
  });

  it("rejects a paid session owned by another account before any fulfillment", async () => {
    state.session.client_reference_id = "owner-b";
    state.session.metadata = { userId: "owner-b" };
    state.session.payment_status = "paid";
    const response = await POST(request());
    expect(response.status).toBe(403);
    expect(adoptPaidPortalCheckoutForOwner).not.toHaveBeenCalled();
    expect(recordPaidManagerCheckoutSession).not.toHaveBeenCalled();
  });
});
