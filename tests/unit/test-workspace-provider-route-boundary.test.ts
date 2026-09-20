import { beforeEach, describe, expect, it, vi } from "vitest";

const user = vi.hoisted(() => vi.fn());
const providerGate = vi.hoisted(() => vi.fn());
const stripeFactory = vi.hoisted(() => vi.fn());
const serviceDb = vi.hoisted(() => vi.fn());

vi.mock("@/lib/demo/demo-session", () => ({ isDemoModeActive: () => false }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: () => ({ auth: { getUser: user } }),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: serviceDb }));
vi.mock("@/lib/stripe", () => ({ getStripe: stripeFactory }));
vi.mock("@/lib/test-workspaces/effects.server", () => {
  class TestWorkspaceProviderDisabledError extends Error {
    constructor() { super("This provider operation is unavailable for test accounts."); }
  }
  return { assertTestWorkspaceProviderEffectAllowed: providerGate, TestWorkspaceProviderDisabledError };
});

import { POST } from "@/app/api/stripe/resident-payment-methods/route";
import { TestWorkspaceProviderDisabledError } from "@/lib/test-workspaces/effects.server";

function profileDb() {
  const query = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: { full_name: "Test Resident" }, error: null }),
    update: vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue({ error: null }),
    }),
  };
  return { from: vi.fn().mockReturnValue(query) };
}

beforeEach(() => {
  vi.clearAllMocks();
  user.mockResolvedValue({ data: { user: { id: "test-user", email: "test@example.com" } } });
  serviceDb.mockReturnValue(profileDb());
});

describe("ordinary Stripe route test-workspace boundary", () => {
  it("returns a refusal before creating a Stripe customer or setup session", async () => {
    providerGate.mockRejectedValue(new TestWorkspaceProviderDisabledError());
    const response = await POST(new Request("https://prop-lane.test/api/stripe/resident-payment-methods", {
      method: "POST",
      body: JSON.stringify({ kind: "card", returnUrl: "https://prop-lane.test/resident/payments" }),
    }));

    expect(response.status).toBe(403);
    expect(stripeFactory).not.toHaveBeenCalled();
  });

  it("keeps the normal customer setup path available", async () => {
    providerGate.mockResolvedValue(undefined);
    const stripe = {
      customers: { create: vi.fn().mockResolvedValue({ id: "cus_normal" }) },
      checkout: { sessions: { create: vi.fn().mockResolvedValue({ client_secret: "seti_normal" }) } },
    };
    stripeFactory.mockReturnValue(stripe);
    const response = await POST(new Request("https://prop-lane.test/api/stripe/resident-payment-methods", {
      method: "POST",
      body: JSON.stringify({ kind: "card", returnUrl: "https://prop-lane.test/resident/payments" }),
    }));

    expect(response.status).toBe(200);
    expect(stripe.customers.create).toHaveBeenCalledOnce();
    expect(stripe.checkout.sessions.create).toHaveBeenCalledOnce();
  });
});
