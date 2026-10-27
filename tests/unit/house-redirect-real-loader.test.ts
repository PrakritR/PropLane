// The per_workspace house redirect through the REAL `getPublicListings` loader (db rows mocked), not an injected
// `allListings`. An injected fixture always carried a workspaceId, so a loader that forgot the server-only
// `{ workspaceId: true }` opt-in made `paidNumberOf` return null for every home and every paid-home redirect fell back to
// NO_PAID_NUMBER_HOME_REPLY while every unit test stayed green.
import { beforeEach, describe, expect, it, vi } from "vitest";

const serviceDb = vi.hoisted(() => vi.fn());
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: serviceDb }));
vi.mock("@/lib/server-env", () => ({ isProductionRuntime: () => false }));
vi.mock("@/lib/manager-assistant-email/manager-assistant-email.server", () => ({ resolveActiveManagerWorkEmail: async () => null }));

const WS_PAID = "33333333-3333-4333-8333-333333333333";
const WS_FREE = "22222222-2222-4222-8222-222222222222";

// The paid manager owns a live work number; the free one has none and no entitlement.
vi.mock("@/lib/sms/manager-number-provisioning.server", () => ({
  resolveActiveManagerSendNumber: async (_db: unknown, _owner: string, workspaceId: string | null) => (workspaceId === WS_PAID ? "+15025550142" : null),
}));
vi.mock("@/lib/one-number/personal-number-entitlement.server", () => ({
  managerPersonalNumberEntitlement: async (_db: unknown, owner: string) => ({ ok: true, entitled: owner === `mgr-${WS_PAID}` }),
}));

import { getPublicListings } from "@/lib/public-listings.server";
import { NO_PAID_NUMBER_HOME_REPLY, resetHouseRedirectCache, resolveHouseRedirect } from "@/lib/one-number/house-redirect.server";

const row = (id: string, workspace: string, street: string) => ({
  id,
  manager_user_id: `mgr-${workspace}`,
  workspace_id: workspace,
  status: "live",
  test_workspace_id: null,
  property_data: { title: street, buildingName: street, address: `${street}, Louisville, KY 40202`, adminPublishLive: true },
});

function fakeDb() {
  const rows = [row("h1", WS_PAID, "12 Elm St"), row("h2", WS_FREE, "88 Birch Ave")];
  return {
    from(table: string) {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is", "in", "order", "limit"]) q[m] = () => q;
      q.then = (resolve: (v: unknown) => unknown) => {
        if (table === "manager_property_records") return Promise.resolve(resolve({ data: rows, error: null }));
        return Promise.resolve(resolve({ data: [], error: null }));
      };
      return q;
    },
  };
}

// No `allListings` and no `paidNumberOf`: the real loader and the default paid-number resolver both run.
const deps = { serviceListings: async () => [], serviceWorkspaceIds: async () => [] };

beforeEach(() => {
  vi.clearAllMocks();
  resetHouseRedirectCache();
  serviceDb.mockReturnValue(fakeDb());
});

describe("house redirect over the real public-listings loader", () => {
  it("names the paid manager's number for their home (a loader that drops workspaceId fails here)", async () => {
    const reply = await resolveHouseRedirect(fakeDb() as never, "is 12 Elm St still available?", deps);
    expect(reply).toBe("For 12 Elm St, Louisville, text (502) 555-0142.");
  });

  it("still names nothing for a self-serve home whose manager has no paid number", async () => {
    const reply = await resolveHouseRedirect(fakeDb() as never, "is 88 Birch Ave still available?", deps);
    expect(reply).toBe(NO_PAID_NUMBER_HOME_REPLY);
  });

  it("getPublicListings() without the opt-in still omits workspaceId; the opt-in is server-only", async () => {
    const stripped = await getPublicListings();
    expect(stripped.length).toBe(2);
    for (const p of stripped) expect(p).not.toHaveProperty("workspaceId");
    const withWs = await getPublicListings({ workspaceId: true });
    expect(withWs.map((p) => p.workspaceId).sort()).toEqual([WS_FREE, WS_PAID]);
  });
});
