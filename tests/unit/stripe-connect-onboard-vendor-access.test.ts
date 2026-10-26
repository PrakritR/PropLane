import { beforeEach, describe, expect, it, vi } from "vitest";

/** R1: the vendor onboard route authorizes off profile_roles (requireVendorApiAccess), never the legacy profiles.role. */
let access: { ok: true; actor: Record<string, unknown> } | { ok: false; status: 401 | 403 } = { ok: false, status: 401 };
vi.mock("@/lib/auth/vendor-api-access", () => ({ requireVendorApiAccess: async () => access }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    // Legacy single role says "manager": a multi-role vendor must still pass.
    auth: { getUser: async () => ({ data: { user: { id: "legacy-manager" } } }) },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { role: "manager" } }) }) }) }),
  }),
}));
vi.mock("@/lib/stripe", () => ({ getStripe: () => ({}) }));
const ensureVendor = vi.fn().mockResolvedValue("acct_v1");
vi.mock("@/lib/stripe-connect-account", () => ({ ensureVendorConnectAccountId: (...a: unknown[]) => ensureVendor(...a) }));
vi.mock("@/lib/stripe-connect", () => ({
  connectAccountReadyForAchPayouts: () => true,
  connectAccountTransfersActive: () => true,
  ensureConnectAccountTransfersRequested: async () => ({ id: "acct_v1", details_submitted: true }),
  isApplicationCollected: () => false,
  isStripeConnectAccountAccessError: () => false,
  clearManagerConnectAccountId: vi.fn(),
  resolveManagerConnectAccountId: vi.fn().mockResolvedValue(null),
  retrieveManagerConnectAccountOrNull: vi.fn(),
}));

import { POST } from "@/app/api/vendor/stripe-connect/onboard/route";

const call = () => POST(new Request("http://x/api/vendor/stripe-connect/onboard", { method: "POST" }));

describe("POST /api/vendor/stripe-connect/onboard access", () => {
  beforeEach(() => ensureVendor.mockClear());

  it("200 for a multi-role vendor whose legacy profiles.role is not vendor", async () => {
    access = { ok: true, actor: { userId: "u-multi", email: "v@example.com", roles: ["manager", "vendor"] } };
    const res = await call();
    expect(res.status).toBe(200);
    expect(ensureVendor.mock.calls[0]![2]).toMatchObject({ userId: "u-multi", email: "v@example.com" });
  });

  it("403 without the vendor role, 401 signed out; Stripe is never reached", async () => {
    access = { ok: false, status: 403 };
    expect((await call()).status).toBe(403);
    access = { ok: false, status: 401 };
    expect((await call()).status).toBe(401);
    expect(ensureVendor).not.toHaveBeenCalled();
  });
});
