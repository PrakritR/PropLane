import { afterEach, describe, expect, it, vi } from "vitest";

const retrieve = vi.fn();
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: vi.fn(() => { throw new Error("must not touch the database while the policy is off"); }) }));
vi.mock("@/lib/stripe", () => ({ getStripe: () => ({ accounts: { retrieve, update: vi.fn() } }) }));

import { GET } from "@/app/api/cron/manual-payout-policy/route";

/** C2-SX8: converting live connected accounts to withdraw-only is a captain-controlled rollout. */
describe("manual payout policy cron", () => {
  const PREV_FLAG = process.env.MANUAL_PAYOUT_POLICY_ENABLED;
  const PREV_SECRET = process.env.CRON_SECRET;
  afterEach(() => {
    if (PREV_FLAG === undefined) delete process.env.MANUAL_PAYOUT_POLICY_ENABLED; else process.env.MANUAL_PAYOUT_POLICY_ENABLED = PREV_FLAG;
    if (PREV_SECRET === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = PREV_SECRET;
  });

  it("does nothing to any Stripe account while MANUAL_PAYOUT_POLICY_ENABLED is off", async () => {
    delete process.env.MANUAL_PAYOUT_POLICY_ENABLED;
    process.env.CRON_SECRET = "s";
    const res = await GET(new Request("http://x/api/cron/manual-payout-policy", { headers: { authorization: "Bearer s" } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped: "MANUAL_PAYOUT_POLICY_ENABLED is off" });
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("still refuses an unauthenticated call", async () => {
    process.env.MANUAL_PAYOUT_POLICY_ENABLED = "1";
    process.env.CRON_SECRET = "s";
    const res = await GET(new Request("http://x/api/cron/manual-payout-policy"));
    expect(res.status).toBe(401);
  });
});
