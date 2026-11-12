/**
 * Plan isolation (managed-ownership design R4): once a PropLane-managed (`is_service`) workspace is owned by the admin,
 * its houses, seats and residents must never count against, be limited by or be billed to the admin's OWN plan.
 * Every test here FAILS if a managed house is counted.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { RATE_CARD } from "@/lib/billing/rate-card";

type Row = Record<string, unknown>;
let TABLES: Record<string, Row[]> = {};
let TIER: string | null = "free";
let LIVE_TRIAL = false;

vi.mock("@/lib/manager-access-server", () => ({
  getEffectiveManagerSkuTier: async () => ({ ok: true, tier: TIER, liveSignupTrial: LIVE_TRIAL }),
}));
vi.mock("@/lib/manager-billing-overrides", async (orig) => ({
  ...(await orig<typeof import("@/lib/manager-billing-overrides")>()),
  loadManagerBillingOverrides: async () => ({ ok: true, overrides: { propertyCap: null } }),
}));

/** A table-aware PostgREST stand-in: eq / in / neq / or(workspace filter) / maybeSingle / head count. */
function fakeDb(): SupabaseClient {
  return {
    from(table: string) {
      let rows = [...(TABLES[table] ?? [])];
      const q: Record<string, unknown> = {
        select: () => q,
        eq: (c: string, v: unknown) => ((rows = rows.filter((r) => r[c] === v)), q),
        neq: (c: string, v: unknown) => ((rows = rows.filter((r) => r[c] !== v)), q),
        in: (c: string, vs: unknown[]) => ((rows = rows.filter((r) => vs.includes(r[c]))), q),
        or: (expr: string) => {
          const m = /^workspace_id\.is\.null,workspace_id\.not\.in\.\((.*)\)$/.exec(expr);
          const h = /^property_id\.in\.\((.*)\),assigned_property_id\.in\.\((.*)\)$/.exec(expr);
          if (h) {
            const ids = h[1]!.split(",");
            rows = rows.filter((r) => ids.includes(String(r.property_id)) || ids.includes(String(r.assigned_property_id)));
            return q;
          }
          if (!m) return q; // the resident bucket filter is modelled by the rows themselves
          const out = m[1]!.split(",");
          rows = rows.filter((r) => !r.workspace_id || !out.includes(String(r.workspace_id)));
          return q;
        },
        limit: () => q,
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: rows, count: rows.length, error: null }).then(resolve),
      };
      return q;
    },
  } as unknown as SupabaseClient;
}

const ADMIN = "11111111-1111-4111-8111-111111111111";
const MANAGED_WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWN_WS = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const house = (id: string, workspace_id: string | null, status = "live"): Row => ({
  id, manager_user_id: ADMIN, workspace_id, status, row_data: {}, property_data: { listingSubmission: { listingPlaceCategoryId: "shared_home", rooms: [{ occupancyCapacity: 1 }] } },
});

beforeEach(() => {
  TIER = "free";
  LIVE_TRIAL = false;
  TABLES = {
    portal_workspaces: [
      { id: MANAGED_WS, owner_user_id: ADMIN, is_service: true },
      { id: OWN_WS, owner_user_id: ADMIN, is_service: false },
    ],
    manager_property_records: [],
  };
});

describe("managed houses never count against the admin's own plan", () => {
  it("the Free door cap and listing slots ignore any number of managed houses", async () => {
    const { assertManagerPropertyListingQuota, countManagerListingSlots } = await import("@/lib/manager-property-quota.server");
    const cap = RATE_CARD.free.includedDoors;
    TABLES.manager_property_records = Array.from({ length: cap + 5 }, (_, i) => house(`m${i}`, MANAGED_WS));
    const slots = await countManagerListingSlots(fakeDb(), ADMIN);
    expect(slots).toEqual({ ok: true, count: 0 });
    // A first self-serve listing is still allowed although 5+ managed houses would blow the Free cap.
    const verdict = await assertManagerPropertyListingQuota(fakeDb(), {
      ownerUserId: ADMIN, recordId: "own-1", nextStatus: "live", existingStatus: null, incomingDoors: 1, workspaceId: OWN_WS,
    });
    expect(verdict).toEqual({ ok: true });
  });

  it("an own house still counts, so the exclusion is not a blanket pass", async () => {
    const { countManagerListingSlots } = await import("@/lib/manager-property-quota.server");
    TABLES.manager_property_records = [house("m1", MANAGED_WS), house("o1", OWN_WS), house("o2", null)];
    expect(await countManagerListingSlots(fakeDb(), ADMIN)).toEqual({ ok: true, count: 2 });
  });

  it("a new house written INTO a managed workspace is never refused by the owner's plan", async () => {
    const { assertManagerPropertyListingQuota } = await import("@/lib/manager-property-quota.server");
    const cap = RATE_CARD.free.includedDoors;
    TABLES.manager_property_records = Array.from({ length: cap + 2 }, (_, i) => house(`o${i}`, OWN_WS));
    const own = await assertManagerPropertyListingQuota(fakeDb(), { ownerUserId: ADMIN, recordId: "x", nextStatus: "live", existingStatus: null, incomingDoors: 1, workspaceId: OWN_WS });
    expect(own.ok).toBe(false);
    const managed = await assertManagerPropertyListingQuota(fakeDb(), { ownerUserId: ADMIN, recordId: "y", nextStatus: "live", existingStatus: null, incomingDoors: 4, workspaceId: MANAGED_WS });
    expect(managed).toEqual({ ok: true });
  });

  it("a house with a stored managed workspace is judged by that workspace when the write names none", async () => {
    const { assertManagerPropertyListingQuota } = await import("@/lib/manager-property-quota.server");
    const cap = RATE_CARD.free.includedDoors;
    TABLES.manager_property_records = [...Array.from({ length: cap + 2 }, (_, i) => house(`o${i}`, OWN_WS)), house("draft-m", MANAGED_WS, "draft")];
    const verdict = await assertManagerPropertyListingQuota(fakeDb(), { ownerUserId: ADMIN, recordId: "draft-m", nextStatus: "live", existingStatus: "draft" });
    expect(verdict).toEqual({ ok: true });
  });

  it("the door count that bills excludes managed houses", async () => {
    const { loadManagerDoorCount } = await import("@/lib/billing/door-count.server");
    TABLES.manager_property_records = [house("m1", MANAGED_WS), house("m2", MANAGED_WS), house("o1", OWN_WS)];
    const result = await loadManagerDoorCount(fakeDb(), ADMIN);
    expect(result.ok && result.breakdown.map((b) => b.propertyId)).toEqual(["o1"]);
  });

  it("the plan card's usage (workspaces, properties, seats, residents) excludes a managed workspace and never strands it", async () => {
    const { loadWorkspacePlan } = await import("@/lib/workspaces/server");
    TABLES.account_link_invites = [
      { id: "s1", inviter_user_id: ADMIN, status: "accepted", workspace_id: MANAGED_WS },
      { id: "s2", inviter_user_id: ADMIN, status: "accepted", workspace_id: OWN_WS },
    ];
    TABLES.manager_application_records = [
      { id: "a1", manager_user_id: ADMIN, property_id: "m1", assigned_property_id: "m1" },
      { id: "a2", manager_user_id: ADMIN, property_id: "o1", assigned_property_id: "o1" },
    ];
    const ws = (id: string, isService: boolean, propertyIds: string[]) => ({ id, name: id, ownerUserId: ADMIN, owned: true, isDefault: !isService, propertyIds, propertyPermissions: {}, ...(isService ? { isService: true } : {}) });
    const reads = {
      tierResult: { ok: true, tier: "free" },
      links: { count: 2 },
      vendors: { count: 0 },
      addons: { ok: true, quantities: {} },
      residents: { count: 2 },
    } as never;
    const plan = await loadWorkspacePlan(fakeDb(), ADMIN, [ws(OWN_WS, false, ["o1"]), ws(MANAGED_WS, true, ["m1", "m2", "m3"])] as never, reads);
    expect(plan.usage.workspaces).toBe(1);
    expect(plan.usage.properties).toBe(1);
    expect(plan.usage.team).toBe(1);
    expect(plan.usage.residents).toBe(1);
    expect(plan.unknown).toBe(false);
  });
});

describe("managed workspaces are never refused for the admin's own communication plan", () => {
  it("a live-trial owner can send from a managed workspace but not from their own", async () => {
    const { assertManagerCommunicationAllowedForWorkspace } = await import("@/lib/manager-communication-access.server");
    LIVE_TRIAL = true;
    const managed = await assertManagerCommunicationAllowedForWorkspace(fakeDb(), ADMIN, MANAGED_WS);
    expect(managed).toEqual({ allowed: true });
    const own = await assertManagerCommunicationAllowedForWorkspace(fakeDb(), ADMIN, OWN_WS);
    expect(own.allowed).toBe(false);
  });
});

describe("the tier resolver reads the purchase alone", () => {
  it("has no house or workspace input, so a managed house cannot move the plan", async () => {
    const { resolveEffectiveManagerSkuTier } = await import("@/lib/manager-access");
    expect(resolveEffectiveManagerSkuTier({ tier: null })).toBe("free");
    expect(resolveEffectiveManagerSkuTier({ tier: "pro", stripeSubscriptionId: "sub_1" })).toBe("pro");
    expect(resolveEffectiveManagerSkuTier.length).toBe(1);
  });
});
