import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authUser: null as { id: string; email?: string } | null,
  ensurePricing: vi.fn(),
  checkoutCreate: vi.fn(),
  classification: vi.fn(),
  serviceDb: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: mocks.authUser } })) },
  })),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: mocks.serviceDb,
}));
vi.mock("@/lib/auth/manager-pricing-selection", () => ({
  ensureProvisionedManagerForPricing: mocks.ensurePricing,
}));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({ checkout: { sessions: { create: mocks.checkoutCreate } } }),
}));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveTestWorkspaceClassification: mocks.classification,
}));

import { POST } from "@/app/api/stripe/checkout/route";
import { createManagerCheckoutSession } from "@/lib/stripe/manager-checkout";

function request(body: Record<string, unknown>) {
  return new Request("http://localhost/api/stripe/checkout", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function checkoutDb() {
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    not: vi.fn(() => query),
    limit: vi.fn(() => query),
    maybeSingle: vi.fn(async () => ({ data: null, error: null })),
    upsert: vi.fn(async () => ({ error: null })),
    // Per-door billing (step 3) resolves the account's live door count as
    // part of checkout for a paid tier — the same `.select().eq().in(...)`
    // chain `loadManagerDoorCount` issues against `manager_property_records`.
    // Empty by default: this suite is about checkout ownership boundaries,
    // not billing, so a brand-new/test caller here always has zero doors.
    in: vi.fn(async () => ({ data: [], error: null })),
  };
  return { from: vi.fn(() => query), query };
}

describe("test-workspace manager checkout boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authUser = null;
    mocks.classification.mockResolvedValue({ kind: "normal" });
    mocks.ensurePricing.mockResolvedValue({ kind: "ready", managerId: "MGR-AUTH" });
    process.env.STRIPE_PRICE_PRO_MONTHLY = "price_pro_monthly_test";
  });

  it("rejects a guest body UUID when the submitted email belongs to a classified account", async () => {
    const db = checkoutDb();
    db.query.maybeSingle.mockResolvedValueOnce({ data: { user_id: "classified-owner" }, error: null });
    mocks.serviceDb.mockReturnValue(db);
    mocks.classification.mockResolvedValue({ kind: "classified", workspaceId: "workspace-1", role: "manager", state: "active" });

    const response = await POST(request({
      tier: "pro",
      billing: "monthly",
      email: "private@example.com",
      userId: "normal-attacker-id",
    }));

    expect(response.status).toBe(403);
    expect(mocks.checkoutCreate).not.toHaveBeenCalled();
  });

  it("gates an authenticated classified account before pricing provisioning", async () => {
    mocks.authUser = { id: "classified-owner", email: "private@example.com" };
    mocks.serviceDb.mockReturnValue(checkoutDb());
    mocks.classification.mockResolvedValue({ kind: "classified", workspaceId: "workspace-1", role: "manager", state: "suspended" });

    const response = await POST(request({ tier: "pro", billing: "monthly" }));

    expect(response.status).toBe(403);
    expect(mocks.ensurePricing).not.toHaveBeenCalled();
    expect(mocks.checkoutCreate).not.toHaveBeenCalled();
  });

  it.each([
    { mode: "embedded", session: { id: "cs_embedded", client_secret: "secret" }, embedded: true },
    { mode: "hosted", session: { id: "cs_hosted", url: "https://checkout.stripe.test/session" }, embedded: false },
  ])("reserves the durable owner before returning a $mode checkout", async ({ session, embedded }) => {
    const db = checkoutDb();
    mocks.serviceDb.mockReturnValue(db);
    mocks.checkoutCreate.mockResolvedValue(session);

    const result = await createManagerCheckoutSession({
      tier: "pro",
      billing: "monthly",
      email: "manager@example.com",
      userId: "normal-owner",
      embedded,
      req: new Request("http://localhost/partner/pricing"),
    });

    expect(result.ok).toBe(true);
    expect(db.query.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        stripe_checkout_session_id: session.id,
        email: "manager@example.com",
        user_id: "normal-owner",
      }),
      { onConflict: "manager_id" },
    );
  });
});
