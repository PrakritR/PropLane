import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * `mintInviteLink` used to cap permissions BEFORE stamping the role, so the
 * stamp then overwrote the capped map with the full role grant on every
 * requested property. Worse, for `houseScope: "all"` the requested property
 * set itself was the WORKSPACE OWNER's full house list, never narrowed to
 * what the acting delegate (an Admin whose own membership is scoped to a
 * subset) actually holds. Together an Admin scoped to one house could mint
 * an "all houses, Admin" link reaching every house in the workspace
 * (security review Warning: mint-link-stamp-after-cap). `POST
 * /api/pro/account-links` already stamps then caps; this proves the invite
 * LINK path now matches it and that the property set itself is capped too.
 */
vi.mock("@/lib/manager-access-server", () => ({
  getEffectiveManagerSkuTier: vi.fn(async () => ({ ok: true, tier: "business" })),
}));
vi.mock("@/lib/co-manager-plan-access.server", () => ({
  managerPlanAllowsCoManagerInvites: () => true,
}));

import { mintInviteLink } from "@/lib/invite-links/invite-links.server";
import { stampTeamRoleOnProperties } from "@/lib/co-manager-team-roles";

const OWNER = "owner-1";
const ADMIN = "admin-1";
const WORKSPACE_ID = "ws-1";

/** The Admin's OWN accepted membership: scoped to one of the workspace's three houses. */
const adminOwnRow = {
  id: "link-admin-own",
  inviter_user_id: OWNER,
  invitee_user_id: ADMIN,
  team_role: "admin",
  workspace_permissions: {},
  assigned_property_ids: ["house-A"],
  property_co_manager_permissions: stampTeamRoleOnProperties("admin", ["house-A"], {}),
  co_manager_permissions: {},
  house_scope: "selected",
};

let insertedLink: Record<string, unknown> | null;

/** @param ownRow The Admin's own accepted membership row — swappable per test. */
function makeDb(ownRow: Record<string, unknown> = adminOwnRow): SupabaseClient {
  return {
    from(table: string) {
      let selectCols = "";
      let insertPayload: Record<string, unknown> | null = null;
      const resolve = (): { data: unknown; error: unknown } => {
        if (table === "portal_workspaces") {
          return { data: { id: WORKSPACE_ID, name: "Acme Portfolio", owner_user_id: OWNER }, error: null };
        }
        if (table === "account_link_invites") {
          if (selectCols.startsWith("inviter_user_id, invitee_user_id")) {
            // collectLinkedPropertyPermissionsForUser — every accepted row the actor holds.
            return { data: [ownRow], error: null };
          }
          // actorWorkspaceStanding's own-membership lookup, or actorOwnWorkspaceHouseIds.
          return { data: ownRow, error: null };
        }
        if (table === "manager_property_records") {
          if (selectCols.includes("row_data")) {
            return { data: [{ id: "house-A", row_data: { buildingName: "House A" } }], error: null };
          }
          // Every house the workspace OWNER holds — three, not just the Admin's one.
          return { data: [{ id: "house-A" }, { id: "house-B" }, { id: "house-C" }], error: null };
        }
        if (table === "manager_invite_links" && insertPayload) {
          insertedLink = insertPayload;
          return { data: { ...insertPayload, id: "new-link-id" }, error: null };
        }
        return { data: null, error: null };
      };
      const q: Record<string, unknown> = {
        select: vi.fn((cols?: string) => {
          selectCols = cols ?? "";
          return q;
        }),
        eq: vi.fn(() => q),
        in: vi.fn(() => q),
        is: vi.fn(() => q),
        order: vi.fn(() => q),
        update: vi.fn(() => q),
        insert: vi.fn((payload: Record<string, unknown>) => {
          insertPayload = payload;
          return q;
        }),
        maybeSingle: vi.fn(async () => {
          const out = resolve();
          return { data: Array.isArray(out.data) ? (out.data[0] ?? null) : out.data, error: out.error };
        }),
        then: (res: (v: unknown) => unknown) => Promise.resolve(resolve()).then(res),
      };
      return q;
    },
  } as unknown as SupabaseClient;
}

beforeEach(() => {
  insertedLink = null;
});

describe("mintInviteLink caps a delegate's property set, not just permission levels", () => {
  it("a selected-house Admin minting an all-houses Admin link gets only their own houses", async () => {
    const result = await mintInviteLink(makeDb(), {
      actorUserId: ADMIN,
      kind: "manager",
      assignedPropertyIds: [],
      propertyPermissions: {},
      workspaceId: WORKSPACE_ID,
      teamRole: "admin",
      houseScope: "all",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Never the workspace owner's full three-house set.
    expect(result.link.assignedPropertyIds).toEqual(["house-A"]);
    expect(insertedLink?.assigned_property_ids).toEqual(["house-A"]);
    // The stamp itself is fine (Admin on the one house they hold) — the bug
    // was reaching houses outside that grant at all, not the grant's shape.
    expect(result.link.propertyPermissions["house-B"]).toBeUndefined();
    expect(result.link.propertyPermissions["house-C"]).toBeUndefined();
  });

  it("stamps before capping, so a role above what the delegate holds on a house they DO hold is refused, not silently escalated", async () => {
    // The Admin's own row grants only `leases: read` on house-A (weaker than
    // the full Admin stamp). `capTeamInvitePermissionsForDelegate` REFUSES
    // rather than silently downgrading when the requested grant exceeds the
    // delegate's own ("delegates exceeding their grant are refused"). Under
    // the OLD cap-then-stamp order, capping ran on the caller's (here empty)
    // `propertyPermissions` input BEFORE the stamp existed, so it never saw
    // the full Admin request at all — the stamp then overwrote the passed
    // cap with full Admin power on house-A regardless of this weak grant,
    // a silent escalation. Stamping first makes the cap see what is actually
    // being requested, so this now correctly fails closed instead.
    const weakGrant = {
      ...adminOwnRow,
      property_co_manager_permissions: { "house-A": { leases: { read: true } } },
    };

    const result = await mintInviteLink(makeDb(weakGrant), {
      actorUserId: ADMIN,
      kind: "manager",
      assignedPropertyIds: [],
      propertyPermissions: {},
      workspaceId: WORKSPACE_ID,
      teamRole: "admin",
      houseScope: "all",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(403);
    expect(result.error).toContain("You cannot grant module access beyond what you have");
  });
});
