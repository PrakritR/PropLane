/**
 * An owner cannot invite, edit or remove members, and an owner-only account is
 * not a manager to any manager API.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/manager-access-server", () => ({
  getEffectiveManagerSkuTier: vi.fn(async () => ({ ok: true, tier: "pro" })),
}));
vi.mock("@/lib/co-manager-plan-access.server", () => ({
  managerPlanAllowsCoManagerInvites: () => true,
}));

const session: { userId: string | null } = { userId: "owner-user" };
let serviceDb: unknown;
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: session.userId ? { id: session.userId, user_metadata: {} } : null } }) },
  }),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => serviceDb }));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveAuthenticatedBusinessAccess: async () => ({ kind: "normal" }),
}));

import { mintInviteLink } from "@/lib/invite-links/invite-links.server";
import { ownerAccessStateFor } from "@/lib/property-owner/access.server";
import { requireOwnerRoute } from "@/lib/property-owner/route-auth.server";
import { requireManagerRouteUser } from "@/lib/manager-route-guard.server";
import { actorWorkspaceStanding } from "@/lib/workspaces/membership.server";
import { makeFakeDb } from "./property-owner-fake-db";

const OWNER = "owner-user";
const MANAGER = "manager-1";
const WS = "ws-1";

const ownerRow = {
  id: "l1",
  inviter_user_id: MANAGER,
  invitee_user_id: OWNER,
  status: "accepted",
  team_role: "property_owner",
  workspace_id: WS,
  house_scope: "selected",
  assigned_property_ids: ["house-a"],
  property_co_manager_permissions: { "house-a": { ownerPerformance: { read: true } } },
  workspace_permissions: { teams: true, addProperties: true },
};

const base = {
  portal_workspaces: [{ id: WS, name: "Main", owner_user_id: MANAGER }],
  profiles: [{ id: OWNER, email: "dana@example.com", role: "manager" }, { id: MANAGER, email: "m@example.com" }],
  profile_roles: [{ user_id: OWNER, role: "manager" }],
  manager_property_records: [{ id: "house-a", manager_user_id: MANAGER, workspace_id: WS }],
};

describe("an owner cannot run the workspace", () => {
  it("has no workspace standing that carries the members right, even with legacy flags set", async () => {
    const db = makeFakeDb({ ...base, account_link_invites: [ownerRow] });
    const standing = await actorWorkspaceStanding(db, OWNER, WS);
    expect(standing?.role).toBe("property_owner");
    expect(standing?.rights).toEqual({ members: false, houses: false });
  });

  it("is refused when it tries to mint an invite link, for any role", async () => {
    const db = makeFakeDb({ ...base, account_link_invites: [ownerRow] });
    for (const teamRole of ["property_owner", "viewer", "admin", "custom"]) {
      const result = await mintInviteLink(db, {
        actorUserId: OWNER,
        kind: "manager",
        workspaceId: WS,
        assignedPropertyIds: ["house-a"],
        propertyPermissions: {},
        teamRole,
      });
      expect(result, teamRole).toMatchObject({ ok: false, status: 403 });
    }
  });
});

describe("an owner-only account is not a manager to any manager API", () => {
  it("is owner-only with owner memberships and nothing else", async () => {
    const db = makeFakeDb({ ...base, account_link_invites: [ownerRow], manager_purchases: [] });
    expect(await ownerAccessStateFor(db, OWNER)).toMatchObject({ hasOwnerAccess: true, ownerOnly: true });
  });

  it("stays owner-only after the membership is revoked, and a real manager who was once an owner does not", async () => {
    const revoked = { ...ownerRow, status: "cancelled" };
    const db = makeFakeDb({ ...base, account_link_invites: [revoked], manager_purchases: [] });
    expect(await ownerAccessStateFor(db, OWNER)).toEqual({ hasOwnerAccess: false, ownerOnly: true, messagesOn: false });
    const pending = makeFakeDb({ ...base, account_link_invites: [{ ...ownerRow, status: "pending" }], manager_purchases: [] });
    expect((await ownerAccessStateFor(pending, OWNER)).ownerOnly).toBe(false);
    const owns = makeFakeDb({ ...base, account_link_invites: [revoked], manager_purchases: [], manager_property_records: [{ id: "mine", manager_user_id: OWNER }] });
    expect((await ownerAccessStateFor(owns, OWNER)).ownerOnly).toBe(false);
  });

  it("is not owner-only when it also owns a house, sits on a team, holds a plan or is an admin", async () => {
    const withOwn = makeFakeDb({ ...base, account_link_invites: [ownerRow], manager_purchases: [], manager_property_records: [{ id: "mine", manager_user_id: OWNER }] });
    expect((await ownerAccessStateFor(withOwn, OWNER)).ownerOnly).toBe(false);
    const withTeam = makeFakeDb({ ...base, account_link_invites: [ownerRow, { ...ownerRow, id: "l2", team_role: "viewer" }], manager_purchases: [] });
    expect((await ownerAccessStateFor(withTeam, OWNER)).ownerOnly).toBe(false);
    const withLegacyTeam = makeFakeDb({ ...base, account_link_invites: [ownerRow, { ...ownerRow, id: "l3", team_role: null }], manager_purchases: [] });
    expect((await ownerAccessStateFor(withLegacyTeam, OWNER)).ownerOnly).toBe(false);
    const withPlan = makeFakeDb({ ...base, account_link_invites: [ownerRow], manager_purchases: [{ id: "p", user_id: OWNER }] });
    expect((await ownerAccessStateFor(withPlan, OWNER)).ownerOnly).toBe(false);
    const asAdmin = makeFakeDb({ ...base, profile_roles: [{ user_id: OWNER, role: "admin" }], account_link_invites: [ownerRow], manager_purchases: [] });
    expect((await ownerAccessStateFor(asAdmin, OWNER)).ownerOnly).toBe(false);
  });

  it("a manager with no owner row costs one read and is plainly not an owner", async () => {
    const db = makeFakeDb({ ...base, account_link_invites: [] });
    expect(await ownerAccessStateFor(db, OWNER)).toEqual({ hasOwnerAccess: false, ownerOnly: false, messagesOn: false });
  });

  it("requireManagerRouteUser refuses it, and still admits a real manager", async () => {
    session.userId = OWNER;
    serviceDb = makeFakeDb({ ...base, account_link_invites: [ownerRow], manager_purchases: [] });
    expect(await requireManagerRouteUser()).toBeNull();
    serviceDb = makeFakeDb({ ...base, account_link_invites: [], manager_purchases: [] });
    expect(await requireManagerRouteUser()).toMatchObject({ userId: OWNER });
  });
});

describe("requireOwnerRoute", () => {
  it("is 401 signed out, 403 without an owner membership, and 403 once access is revoked", async () => {
    session.userId = null;
    serviceDb = makeFakeDb({ ...base, account_link_invites: [ownerRow] });
    expect(((await requireOwnerRoute()) as Response).status).toBe(401);

    session.userId = OWNER;
    serviceDb = makeFakeDb({ ...base, account_link_invites: [] });
    expect(((await requireOwnerRoute()) as Response).status).toBe(403);

    serviceDb = makeFakeDb({ ...base, account_link_invites: [{ ...ownerRow, status: "cancelled" }] });
    expect(((await requireOwnerRoute()) as Response).status).toBe(403);
  });

  it("resolves the manager and houses from the membership, not from anything sent", async () => {
    session.userId = OWNER;
    serviceDb = makeFakeDb({ ...base, account_link_invites: [ownerRow] });
    const ctx = await requireOwnerRoute();
    expect(ctx).not.toBeInstanceOf(Response);
    const grants = (ctx as { grants: { managerUserId: string; houses: { propertyId: string }[] }[] }).grants;
    expect(grants[0]!.managerUserId).toBe(MANAGER);
    expect(grants[0]!.houses.map((h) => h.propertyId)).toEqual(["house-a"]);
  });
});
