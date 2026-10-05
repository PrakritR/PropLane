import { beforeEach, describe, expect, it, vi } from "vitest";

const { getUser, canAccess, isAdmin, from } = vi.hoisted(() => ({
  getUser: vi.fn(), canAccess: vi.fn(async () => true), isAdmin: vi.fn(async () => false), from: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser } }) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({ from }) }));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: isAdmin }));
vi.mock("@/lib/auth/manager-application-access", () => ({ managerCanAccessApplicationRecord: canAccess }));

import { GET } from "@/app/api/manager-applications/[id]/receipt/route";

const application = { id: "application-b", manager_user_id: "manager-1", property_id: "property-1",
  assigned_property_id: null, resident_email: "resident@example.test" };
const claim = { application_id: "application-b", manager_user_id: "manager-1", property_id: "property-1",
  resident_email: "resident@example.test", charge_id: "charge-b", status: "settled", promotion_status: "complete",
  stripe_session_id: "cs_test_b", principal_cents: 5000, payer_total_cents: 5044 };
const charge = { id: "charge-b", status: "paid", row_data: { applicationId: "application-b", amountLabel: "$50.00",
  paidAt: "2026-10-04T12:00:00Z", stripeCheckoutSessionId: "cs_test_b" } };
const ledger = { entry_type: "payment", manager_user_id: "manager-1", amount_cents: 5000,
  stripe_checkout_session_id: "cs_test_b" };

let chargeReadFails = false;
beforeEach(() => {
  vi.clearAllMocks();
  chargeReadFails = false;
  getUser.mockResolvedValue({ data: { user: { id: "viewer-1" } } });
  canAccess.mockResolvedValue(true);
  isAdmin.mockResolvedValue(false);
  from.mockImplementation((table: string) => {
    if (table === "manager_application_records") return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: application, error: null }) }) }) };
    if (table === "application_fee_payment_claims") return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: claim, error: null }) }) }) };
    if (table === "portal_household_charge_records") {
      const q = { eq: () => q, limit: async () => chargeReadFails
        ? { data: null, error: { message: "read failed" } }
        : { data: [charge], error: null } };
      return { select: () => q };
    }
    if (table === "ledger_entries") {
      const q = { eq: () => q, in: () => q, limit: async () => ({ data: [ledger], error: null }) };
      return { select: () => q };
    }
    throw new Error(`unexpected ${table}`);
  });
});

const read = () => GET(new Request("https://example.test/api/manager-applications/application-b/receipt"),
  { params: Promise.resolve({ id: "application-b" }) });

describe("manager application receipt read", () => {
  it("rejects an unrelated manager before reading any payment source", async () => {
    canAccess.mockResolvedValue(false);
    expect((await read()).status).toBe(403);
    expect(from).not.toHaveBeenCalledWith("application_fee_payment_claims");
    expect(from).not.toHaveBeenCalledWith("portal_household_charge_records");
  });

  it("reads only the authorized exact application's stored source", async () => {
    const response = await read();
    expect(response.status).toBe(200);
    expect((await response.json()).receipt).toEqual({ status: "paid", principalCents: 5000,
      paidAt: "2026-10-04T12:00:00Z" });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("returns an error on failed source reads so UI cannot say Not received", async () => {
    chargeReadFails = true;
    const response = await read();
    expect(response.status).toBe(500);
    expect(await response.json()).not.toHaveProperty("receipt.status", "not_received");
  });
});
