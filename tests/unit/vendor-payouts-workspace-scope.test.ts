import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The manager's vendor-payout report listed every payout the paying manager ever made, across all of
 * the workspaces the account owns. A payout belongs to the workspace that holds the house its work
 * order names. Fixture: an owner with workspace A (one house, two payouts, one on a work order
 * naming that house) and an empty workspace B. `loadWorkspaces` and the cookie are the only seams.
 */
type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  selected: "w-a" as string | undefined,
  payouts: [] as Row[],
  workOrders: [] as Row[],
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "proplane_workspace" || name.includes("workspace") ? { value: state.selected } : undefined) }),
}));
vi.mock("@/lib/workspaces/types", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/workspaces/types")>();
  return { ...actual, WORKSPACE_COOKIE: "proplane_workspace" };
});
vi.mock("@/lib/auth/portal-access", () => ({
  getPortalAccessContext: async () => ({ user: { id: "owner-1" }, roles: ["manager"], effectiveRole: "manager" }),
  hasRole: () => true,
  hasAdminRole: () => false,
}));
vi.mock("@/lib/workspaces/server", () => ({
  loadWorkspaces: async () => [
    { id: "w-a", owned: true, isDefault: true, propertyIds: ["house-a"] },
    { id: "w-b", owned: true, isDefault: false, propertyIds: [] },
  ],
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      const result = () => {
        if (table === "vendor_payouts") return state.payouts;
        if (table === "portal_work_order_records") return state.workOrders;
        return [];
      };
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        order: () => chain,
        limit: () => Promise.resolve({ data: result(), error: null }),
        then: (resolve: (v: unknown) => unknown) => resolve({ data: result(), error: null }),
      });
      return chain;
    },
  }),
}));

import { GET } from "@/app/api/manager/vendor-payouts/route";

beforeEach(() => {
  state.selected = "w-a";
  state.payouts = [
    { id: "p1", vendor_user_id: "v1", work_order_id: "wo-a", amount_cents: 5000, status: "paid", created_at: "2026-10-01" },
    { id: "p2", vendor_user_id: "v1", work_order_id: "wo-gone", amount_cents: 900, status: "paid", created_at: "2026-10-02" },
  ];
  state.workOrders = [{ id: "wo-a", property_id: "house-a", assigned_property_id: null, row_data: { title: "Door lock" } }];
});

async function ids() {
  const res = await GET();
  const body = (await res.json()) as { rows: Array<{ id: string }> };
  return body.rows.map((row) => row.id);
}

describe("GET /api/manager/vendor-payouts is the ACTIVE workspace's report", () => {
  it("lists the payout on A's house while A is active, and leaves the unplaceable one out", async () => {
    expect(await ids()).toEqual(["p1"]);
  });

  it("lists nothing from A while the empty workspace B is active", async () => {
    state.selected = "w-b";
    expect(await ids()).toEqual([]);
  });
});
