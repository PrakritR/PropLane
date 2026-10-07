/**
 * A Property owner is an investor: invited to houses somebody chose, never to
 * "every house, now and later". Every write path (POST, PATCH, the mint, the
 * redeem) and the reader (`loadOwnerGrants`) holds that line on its own.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const session: { userId: string | null } = { userId: "admin-1" };
let serviceDb: unknown;

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: session.userId ? { id: session.userId, user_metadata: {} } : null } }) },
    from: (table: string) => (serviceDb as { from: (t: string) => unknown }).from(table),
  }),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => serviceDb }));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveAuthenticatedBusinessAccess: async () => ({ kind: "normal" }),
  assertTestWorkspacePrincipalCompatibility: async () => undefined,
}));
vi.mock("@/lib/property-owner/route-auth.server", () => ({ refuseOwnerOnly: async () => null }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: async () => ({ ok: true }), clientIpFrom: () => "127.0.0.1" }));
vi.mock("@/lib/manager-access-server", () => ({
  getEffectiveManagerSkuTier: vi.fn(async () => ({ ok: true, tier: "business" })),
}));
vi.mock("@/lib/co-manager-plan-access.server", () => ({ managerPlanAllowsCoManagerInvites: () => true }));

import { PATCH } from "@/app/api/pro/account-links/[inviteId]/route";
import { POST } from "@/app/api/pro/account-links/route";
import { mintInviteLink } from "@/lib/invite-links/invite-links.server";
import { loadOwnerGrants } from "@/lib/property-owner/access.server";
import { OWNER_SELECTED_ONLY_ERROR } from "@/lib/workspaces/membership";
import { makeFakeDb } from "./property-owner-fake-db";

const MANAGER = "manager-1";
const ADMIN = "admin-1";
const OWNER = "owner-user";
const WS = "ws-1";
const ON = { read: true, notification: true };

const houses = ["house-a", "house-b", "house-c"].map((id) => ({ id, manager_user_id: MANAGER, workspace_id: WS }));

function tables(extra: Record<string, unknown>[] = []) {
  return {
    portal_workspaces: [{ id: WS, name: "Main", owner_user_id: MANAGER }],
    manager_property_records: houses,
    profiles: [
      { id: OWNER, email: "dana@example.com" },
      { id: MANAGER, email: "manager@example.com" },
      { id: ADMIN, email: "admin@example.com" },
    ],
    account_link_invites: [
      // The Admin's own membership: scoped to house-a only.
      {
        id: "admin-own",
        inviter_user_id: MANAGER,
        invitee_user_id: ADMIN,
        status: "accepted",
        team_role: "admin",
        workspace_id: WS,
        house_scope: "selected",
        assigned_property_ids: ["house-a"],
        property_co_manager_permissions: {},
        workspace_permissions: {},
      },
      ...extra,
    ],
  } as Record<string, Record<string, unknown>[]>;
}

const ownerInvite = {
  id: "owner-invite",
  inviter_user_id: MANAGER,
  invitee_user_id: OWNER,
  status: "accepted",
  team_role: "property_owner",
  workspace_id: WS,
  house_scope: "selected",
  assigned_property_ids: ["house-a"],
  property_co_manager_permissions: { "house-a": { ownerPerformance: ON } },
  co_manager_permissions: {},
  workspace_permissions: {},
  payout_percent_for_manager: 15,
};

const patch = (body: unknown) =>
  PATCH(new Request("https://example.com/api/pro/account-links/owner-invite", { method: "PATCH", body: JSON.stringify(body) }), {
    params: Promise.resolve({ inviteId: "owner-invite" }),
  });

beforeEach(() => {
  session.userId = MANAGER;
  serviceDb = makeFakeDb(tables([{ ...ownerInvite }]));
});

describe("POST /api/pro/account-links", () => {
  it("rejects a property owner invited to all houses", async () => {
    const res = await POST(
      new Request("https://example.com/api/pro/account-links", {
        method: "POST",
        body: JSON.stringify({ inviteeAxisId: "AX-1", workspaceId: WS, teamRole: "property_owner", houseScope: "all", assignedPropertyIds: [] }),
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(OWNER_SELECTED_ONLY_ERROR);
  });

  it("requires at least one house for a property owner", async () => {
    const res = await POST(
      new Request("https://example.com/api/pro/account-links", {
        method: "POST",
        body: JSON.stringify({ inviteeAxisId: "AX-1", workspaceId: WS, teamRole: "property_owner", assignedPropertyIds: [] }),
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/pro/account-links/[inviteId]", () => {
  it("rejects moving an owner to all houses", async () => {
    const res = await patch({ houseScope: "all" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(OWNER_SELECTED_ONLY_ERROR);
  });

  it("rejects changing a member to a property owner with all houses", async () => {
    const res = await patch({ teamRole: "property_owner", houseScope: "all" });
    expect(res.status).toBe(400);
  });

  it("refuses a houses-scoped Admin adding a house beyond their own reach", async () => {
    session.userId = ADMIN;
    const res = await patch({ assignedPropertyIds: ["house-a", "house-b"] });
    expect(res.status).toBe(403);
  });
});

describe("mintInviteLink", () => {
  const base = { actorUserId: MANAGER, kind: "manager", propertyPermissions: {}, workspaceId: WS, teamRole: "property_owner" };
  it("rejects an owner link for all houses and one with no house", async () => {
    const all = await mintInviteLink(makeFakeDb(tables()), { ...base, assignedPropertyIds: [], houseScope: "all" });
    expect(all).toMatchObject({ ok: false, status: 400, error: OWNER_SELECTED_ONLY_ERROR });
    const none = await mintInviteLink(makeFakeDb(tables()), { ...base, assignedPropertyIds: [] });
    expect(none).toMatchObject({ ok: false, status: 400 });
  });
});

describe("loadOwnerGrants", () => {
  it("an owner row stored as all reaches only its assigned houses, never a later-added one", async () => {
    const db = makeFakeDb({
      ...tables(),
      account_link_invites: [
        {
          ...ownerInvite,
          house_scope: "all",
          // house-c joined the workspace later; the trigger added it to the list.
          assigned_property_ids: ["house-a", "house-c"],
          property_co_manager_permissions: { "house-a": { ownerPerformance: ON } },
          co_manager_permissions: { ownerPerformance: ON, ownerStatements: ON, ownerDocuments: ON },
        },
      ],
    });
    const grants = await loadOwnerGrants(db, OWNER);
    expect(grants[0]!.houses.map((h) => h.propertyId)).toEqual(["house-a"]);
  });
});
