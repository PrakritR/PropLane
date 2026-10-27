// The 206's offer catalog through the REAL `getPublicListings` loader (db rows mocked), not an injected `allListings`.
// An injected fixture always carried a workspaceId, so a loader that dropped it left the shared-line catalog empty
// in production while every unit test stayed green.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SharedLineConfig } from "@/lib/one-number/contracts";

const serviceDb = vi.hoisted(() => vi.fn());
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: serviceDb }));
vi.mock("@/lib/server-env", () => ({ isProductionRuntime: () => false }));
vi.mock("@/lib/sms/manager-number-provisioning.server", () => ({ resolveActiveManagerSendNumber: async () => null }));
vi.mock("@/lib/manager-assistant-email/manager-assistant-email.server", () => ({ resolveActiveManagerWorkEmail: async () => null }));

import { getPublicListings } from "@/lib/public-listings.server";
import { getLineOfferListings, getLineCatalogListings, resetLineCatalogCache } from "@/lib/one-number/line-catalog.server";

const WS_SVC = "11111111-1111-4111-8111-111111111111";
const WS_FREE = "22222222-2222-4222-8222-222222222222";
const WS_PAID = "33333333-3333-4333-8333-333333333333";

const SHARED: SharedLineConfig = { mode: "shared", sharedNumber: "+12066781909", messagingServiceSid: "MG1", pilotWorkspaceIds: [], dedicatedWorkspaceIds: [WS_PAID] };

const row = (id: string, workspace: string, street: string) => ({
  id,
  manager_user_id: `mgr-${workspace}`,
  workspace_id: workspace,
  status: "live",
  test_workspace_id: null,
  property_data: { title: street, buildingName: street, address: street, adminPublishLive: true },
});

function fakeDb() {
  const rows = [row("h1", WS_SVC, "4709A 8th Ave"), row("h2", WS_FREE, "12 Ravenna Pl"), row("h3", WS_PAID, "9 Pine St")];
  return {
    from(table: string) {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is", "in", "order", "limit"]) q[m] = () => q;
      q.then = (resolve: (v: unknown) => unknown) => {
        if (table === "portal_workspaces") return Promise.resolve(resolve({ data: [{ id: WS_SVC }], error: null }));
        if (table === "manager_property_records") return Promise.resolve(resolve({ data: rows, error: null }));
        return Promise.resolve(resolve({ data: [], error: null }));
      };
      return q;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetLineCatalogCache();
  serviceDb.mockReturnValue(fakeDb());
});

describe("shared-line catalog over the real loader", () => {
  it("offers every tier's homes (managed, free, paid) - an empty-workspace regression fails here", async () => {
    const offers = await getLineOfferListings(fakeDb() as never, SHARED);
    const byAddress = Object.fromEntries(offers.map((o) => [o.address, o.lineTier]));
    expect(byAddress).toEqual({ "4709A 8th Ave": "managed", "12 Ravenna Pl": "free", "9 Pine St": "paid" });
  });

  it("serves managed + free homes (not the paid manager's) in the served catalog", async () => {
    const served = await getLineCatalogListings(fakeDb() as never, SHARED);
    expect(served.map((p) => p.address).sort()).toEqual(["12 Ravenna Pl", "4709A 8th Ave"]);
  });

  it("never puts the workspace id in a public response", async () => {
    const publicListings = await getPublicListings();
    expect(publicListings.length).toBe(3);
    for (const p of publicListings) expect(p).not.toHaveProperty("workspaceId");
  });
});
