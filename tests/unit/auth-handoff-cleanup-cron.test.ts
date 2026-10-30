import { beforeEach, describe, expect, it, vi } from "vitest";

const gate = vi.fn();
const rpc = vi.fn();
vi.mock("@/lib/cron-auth.server", () => ({ requireCronSecret: (...args: unknown[]) => gate(...args) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({ rpc }) }));
import { GET } from "@/app/api/cron/auth-handoff-cleanup/route";

beforeEach(() => { gate.mockReset(); rpc.mockReset(); gate.mockReturnValue(true); rpc.mockResolvedValue({ error: null }); });
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
});
