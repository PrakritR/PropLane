import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), upsert: vi.fn(), summary: vi.fn() }));
vi.mock("@/lib/manager-route-guard.server", () => ({ requireManagerRouteUser: mocks.auth }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({ from: () => ({ upsert: mocks.upsert }) }) }));
vi.mock("@/lib/comms-billing/summary.server", () => ({ loadManagerCommsBillingSummary: mocks.summary }));
import { PATCH } from "@/app/api/manager/comms-billing/route";
const request = (value: unknown) => new Request("http://localhost/api/manager/comms-billing", { method: "PATCH", body: JSON.stringify({ creditAlertRemainingCents: value }) });
beforeEach(() => { vi.clearAllMocks(); mocks.auth.mockResolvedValue({ userId: "authenticated-owner" }); mocks.upsert.mockResolvedValue({ error: null }); mocks.summary.mockResolvedValue({ creditAlertRemainingCents: 2000 }); });
describe("remaining credit alerts", () => {
  it("stores remaining dollars independently of monthly spend budgets under authenticated owner", async () => {
    expect((await PATCH(request(2000))).status).toBe(200);
    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({ manager_user_id: "authenticated-owner", credit_alert_remaining_cents: 2000, credit_alert_notified_at: null }), { onConflict: "manager_user_id" });
    expect(mocks.upsert.mock.calls[0][0]).not.toHaveProperty("monthly_budget_cents");
  });
  it.each([-1, 1000001, 2.5, "2000"])("refuses invalid threshold %s before writing", async value => {
    expect((await PATCH(request(value))).status).toBe(400); expect(mocks.upsert).not.toHaveBeenCalled();
  });
  it("supports turning alerts off", async () => { expect((await PATCH(request(null))).status).toBe(200); });
  it("refuses unauthenticated updates", async () => { mocks.auth.mockResolvedValue(null); expect((await PATCH(request(2000))).status).toBe(401); expect(mocks.upsert).not.toHaveBeenCalled(); });
});
