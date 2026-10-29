/**
 * The one-shot "release Free accounts' numbers" sweep never releases a number provisioned before 2026-10-29,
 * even when its holder resolves to Free (a FREE100 code expired): grandfathered numbers are never released.
 * Past the cutoff the sweep asks the one entitlement decision, so a Free manager paying for the PropLane
 * Number add-on keeps the line they bought.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  addOn: new Set<string>(),
  release: vi.fn(),
  twilio: vi.fn(),
}));

vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: async () => true }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "admin-1" } } }) } }),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: () => ({ select: () => ({ neq: async () => ({ data: mocks.rows, error: null }) }) }),
  }),
}));
vi.mock("@/lib/manager-access-server", () => ({
  getEffectiveManagerSkuTier: async () => ({ ok: true, tier: "free", billablePlan: false, liveSignupTrial: false }),
}));
vi.mock("@/lib/number-subscription/subscription.server", () => ({
  numberServiceEntitled: async (managerUserId: string) => mocks.addOn.has(managerUserId),
}));
vi.mock("@/lib/sms/manager-number-provisioning.server", () => ({ releaseManagerNumber: mocks.release }));
vi.mock("@/lib/twilio-provisioning", () => ({ releaseTwilioNumber: mocks.twilio }));

import { POST } from "@/app/api/admin/release-free-work-numbers/route";

const row = (id: string, provisionedAt: string) => ({
  manager_user_id: id,
  workspace_id: `ws-${id}`,
  phone_number: "+12065550111",
  phone_number_sid: `PN${id}`,
  provision_state: "active",
  released_at: null,
  provisioned_at: provisionedAt,
  requested_at: provisionedAt,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.twilio.mockResolvedValue(true);
  mocks.addOn.clear();
  mocks.rows = [row("old", "2026-10-20T10:00:00Z"), row("new", "2026-10-30T10:00:00Z")];
});

describe("release-free-work-numbers", () => {
  it("skips a grandfathered number and releases only a post-cutoff Free one", async () => {
    const res = await POST(new Request("http://test/x", { method: "POST", body: JSON.stringify({ dryRun: false }) }));
    const body = await res.json();
    expect(body.skipped).toEqual([{ managerUserId: "old", reason: "grandfathered" }]);
    expect(body.released.map((r: { managerUserId: string }) => r.managerUserId)).toEqual(["new"]);
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(mocks.release).toHaveBeenCalledWith(expect.anything(), "new", "ws-new");
    expect(mocks.twilio).toHaveBeenCalledTimes(1);
  });

  it("keeps the line a Free manager pays for through the PropLane Number add-on", async () => {
    mocks.addOn.add("new");
    const res = await POST(new Request("http://test/x", { method: "POST", body: JSON.stringify({ dryRun: false }) }));
    const body = await res.json();
    expect(body.released).toEqual([]);
    expect(body.skipped).toEqual([
      { managerUserId: "old", reason: "grandfathered" },
      { managerUserId: "new", reason: "entitled_add_on" },
    ]);
    expect(mocks.release).not.toHaveBeenCalled();
    expect(mocks.twilio).not.toHaveBeenCalled();
  });
});
