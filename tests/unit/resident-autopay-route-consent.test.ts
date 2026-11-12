import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "res_1", email: "r@x.com" } } }) } }),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: { email: "r@x.com", role: "resident", manager_id: "mgr_1", stripe_customer_id: "cus_1" } }) }),
      }),
    }),
  }),
}));
vi.mock("@/lib/auth/resident-role-access", () => ({ authorizeResidentRole: async () => true }));
vi.mock("@/lib/stripe", () => ({ getStripe: () => ({}) }));
vi.mock("@/lib/stripe-resident-customer", () => ({
  listResidentSavedPaymentMethods: async () => [
    { id: "pm_1", type: "card", label: "VISA •••• 4242", isDefault: true },
    { id: "pm_2", type: "us_bank_account", label: "Chase •••• 1", isDefault: false },
  ],
}));
vi.mock("@/lib/workspace-payment-settings.server", () => ({
  loadWorkspacePaymentSettingsForProperty: async () => ({}),
  workspaceAutopayEnabled: () => true,
}));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));

const loadSettings = vi.fn();
const saveSettings = vi.fn();
vi.mock("@/lib/resident-autopay.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/resident-autopay.server")>();
  return {
    ...actual,
    resolveResidentAutopayHousehold: async () => ({ propertyId: "prop_1", householdKey: "r@x.com|prop_1", nextCharge: null }),
    loadResidentAutopaySettings: (...a: unknown[]) => loadSettings(...a),
    saveResidentAutopaySettings: (...a: unknown[]) => saveSettings(...a),
  };
});

import { PUT } from "@/app/api/resident/autopay/route";

const put = (body: Record<string, unknown>) =>
  PUT(new Request("http://localhost/api/resident/autopay", { method: "PUT", body: JSON.stringify(body) }) as never);

const authorized = { id: "s", enabled: true, paymentMethodId: "pm_1", consentAt: "2026-09-01T00:00:00Z", consentPaymentMethodId: "pm_1", runDaysBeforeDue: 0 };

describe("PUT /api/resident/autopay: a saved method is not an authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadSettings.mockResolvedValue(null);
    saveSettings.mockImplementation(async (_db: unknown, input: Record<string, unknown>) => ({
      enabled: input.enabled, paymentMethodId: input.paymentMethodId, runDaysBeforeDue: input.runDaysBeforeDue,
    }));
  });

  it("refuses to turn autopay on without consent, and writes nothing", async () => {
    const res = await put({ enabled: true, paymentMethodId: "pm_1" });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("AUTOPAY_CONSENT_REQUIRED");
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it("records consent for the chosen method when the resident agrees", async () => {
    const res = await put({ enabled: true, paymentMethodId: "pm_1", consent: true });
    expect(res.status).toBe(200);
    expect(saveSettings.mock.calls[0]![1]).toMatchObject({ enabled: true, paymentMethodId: "pm_1", consent: { paymentMethodId: "pm_1" } });
  });

  it("changing the run day under an authorization already recorded for the same method does not ask again", async () => {
    loadSettings.mockResolvedValue(authorized);
    const res = await put({ enabled: true, paymentMethodId: "pm_1", runDaysBeforeDue: 3 });
    expect(res.status).toBe(200);
    expect(saveSettings.mock.calls[0]![1].consent).toBeNull();
  });

  it("moving autopay to another method needs a new consent", async () => {
    loadSettings.mockResolvedValue(authorized);
    expect((await put({ enabled: true, paymentMethodId: "pm_2" })).status).toBe(400);
    expect((await put({ enabled: true, paymentMethodId: "pm_2", consent: true })).status).toBe(200);
    expect(saveSettings.mock.calls[0]![1].consent).toEqual({ paymentMethodId: "pm_2" });
  });

  it("turning autopay off needs no consent", async () => {
    const res = await put({ enabled: false });
    expect(res.status).toBe(200);
    expect(saveSettings.mock.calls[0]![1]).toMatchObject({ enabled: false, consent: null });
  });
});
