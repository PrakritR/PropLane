import { beforeEach, describe, expect, it, vi } from "vitest";

const gate = vi.fn();
const rpc = vi.fn();
vi.mock("@/lib/cron-auth.server", () => ({ requireCronSecret: (...args: unknown[]) => gate(...args) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({ rpc }) }));
import { GET } from "@/app/api/cron/auth-handoff-cleanup/route";

beforeEach(() => { gate.mockReset(); rpc.mockReset(); gate.mockReturnValue(true); rpc.mockResolvedValue({ data: 0, error: null }); });
describe("auth handoff cleanup", () => {
  it("rejects unauthorized requests without database access", async () => {
    gate.mockReturnValue(false);
    expect((await GET(new Request("http://localhost"))).status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("purges expired handoffs before capabilities", async () => {
    expect((await GET(new Request("http://localhost"))).status).toBe(200);
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(["purge_expired_email_onboarding_handoffs", "purge_expired_tour_signup_capabilities"]);
  });
  it("fails closed on cleanup error", async () => {
    rpc.mockResolvedValueOnce({ error: { message: "failed" } });
    expect((await GET(new Request("http://localhost"))).status).toBe(503);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  /**
   * Each purge function deletes at most 100 rows per call. Handoffs expire after an hour and this
   * cron runs hourly, so one call per table let any hour that minted more than 100 links grow the
   * table for good (~400/hour at 500 minted).
   */
  it("drains each purge until a batch comes back short", async () => {
    // 100, 100, 40 for the handoffs; then 0 for the capabilities.
    rpc.mockResolvedValueOnce({ data: 100, error: null })
      .mockResolvedValueOnce({ data: 100, error: null })
      .mockResolvedValueOnce({ data: 40, error: null })
      .mockResolvedValueOnce({ data: 0, error: null });

    const res = await GET(new Request("http://localhost"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      removed: { purge_expired_email_onboarding_handoffs: 240, purge_expired_tour_signup_capabilities: 0 },
    });
    expect(rpc.mock.calls.map(([name]) => name)).toEqual([
      "purge_expired_email_onboarding_handoffs",
      "purge_expired_email_onboarding_handoffs",
      "purge_expired_email_onboarding_handoffs",
      "purge_expired_tour_signup_capabilities",
    ]);
  });
  it("stops after a bounded number of batches rather than running unbounded", async () => {
    rpc.mockResolvedValue({ data: 100, error: null });
    expect((await GET(new Request("http://localhost"))).status).toBe(200);
    // 50 per table, never more.
    expect(rpc).toHaveBeenCalledTimes(100);
  });
});
