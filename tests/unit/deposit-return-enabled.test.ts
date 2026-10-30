import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const refund = vi.hoisted(() => vi.fn());
const rpc = vi.hoisted(() => vi.fn());
const stamp = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "owner" } } }) } }) }));
vi.mock("@/lib/test-workspaces/index.server", () => ({ resolveTestWorkspaceClassification: async () => ({ kind: "normal" }) }));
vi.mock("@/lib/auth/co-manager-module-scope", () => ({ resolveManagerWorkspaceRowScope: async () => ({}), rowInWorkspaceScope: () => true }));
vi.mock("@/lib/stripe", () => ({ getStripe: () => ({}) }));
vi.mock("@/lib/household-charge-refund-rail.server", () => ({ refundPaidHouseholdCharge: refund }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({ rpc, from: (table: string) => {
  const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: table === "portal_household_charge_records"
    ? { manager_user_id: "owner", property_id: "home", status: "paid", row_data: { kind: "security_deposit" } }
    : table === "security_deposit_ledger" ? { id: "deposit", property_id: "home", amount_held_cents: 10000 }
      : { stripe_charge_id: "ch_1", amount_cents: 10000, property_id: "home" }, error: null }),
    update: () => ({ eq: () => ({ eq: stamp }) }) };
  return query;
} }) }));
import { POST } from "@/app/api/portal/deposit-return/route";
const post = () => POST(new Request("http://localhost/api/portal/deposit-return", { method: "POST", body: JSON.stringify({ chargeId: "charge", amountCents: 5000, itemization: [] }) }));
beforeEach(() => { vi.clearAllMocks(); process.env.DEPOSIT_RETURN_PROVIDER_ENABLED = "true"; rpc.mockResolvedValue({ data: { id: "attempt" }, error: null }); stamp.mockResolvedValue({ error: null }); });
afterEach(() => { delete process.env.DEPOSIT_RETURN_PROVIDER_ENABLED; });
describe("reserved deposit return", () => {
  it("reserves before the provider and returns pending even when provider succeeds", async () => {
    refund.mockResolvedValue({ refundId: "re_1", status: "succeeded" });
    const res = await post();
    expect(res.status).toBe(202);
    expect((await res.json()).status).toBe("pending");
    expect(rpc.mock.invocationCallOrder[0]).toBeLessThan(refund.mock.invocationCallOrder[0]!);
    expect(refund).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ idempotencyKey: "deposit-return:attempt", metadata: expect.objectContaining({ deposit_return_attempt: "attempt" }) }));
  });
  it("keeps an uncertain provider outcome reserved", async () => {
    refund.mockRejectedValue(new Error("timeout"));
    const res = await post();
    expect((await res.json()).status).toBe("unknown");
    expect(stamp).not.toHaveBeenCalled();
  });
  it("reports unknown if provider id persistence fails", async () => {
    refund.mockResolvedValue({ refundId: "re_1", status: "pending" });
    stamp.mockResolvedValue({ error: { message: "db" } });
    expect((await (await post()).json()).status).toBe("unknown");
  });
  it("does not call Stripe when reservation fails", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "active" } });
    expect((await post()).status).toBe(409);
    expect(refund).not.toHaveBeenCalled();
  });
});
