/**
 * The owner of record of a PropLane Service workspace is a Property owner: signing in lands them in the owner
 * portal (not the manager portal), they read every house of that workspace (including ones added later) through
 * the existing owner keys, and nobody else's owner or manager access changes.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { grantedHouses, loadOwnerGrants, ownerAccessStateFor } from "@/lib/property-owner/access.server";
import { makeFakeDb } from "./property-owner-fake-db";

const read = (p: string) => readFileSync(p, "utf8");

const SERVICE_OWNER = "service-owner";
const CLIENT = "client-user";
const REGULAR_OWNER = "regular-owner";
const WS = "svc-ws";
const VIEW = { read: true, notification: true };

const profiles = [
  { id: SERVICE_OWNER, email: "service@example.com" },
  { id: CLIENT, email: "client@example.com" },
  { id: REGULAR_OWNER, email: "dana@example.com" },
  { id: "manager-1", email: "manager@example.com" },
];

function ownerLink(over: Record<string, unknown>) {
  return {
    id: "link-1",
    inviter_user_id: SERVICE_OWNER,
    invitee_user_id: CLIENT,
    status: "accepted",
    team_role: "property_owner",
    workspace_id: WS,
    house_scope: "selected",
    assigned_property_ids: ["house-a"],
    property_co_manager_permissions: { "house-a": { ownerPerformance: VIEW, ownerStatements: VIEW, ownerDocuments: VIEW } },
    co_manager_permissions: {},
    is_owner_of_record: true,
    ...over,
  };
}

const houses = [
  { id: "house-a", manager_user_id: SERVICE_OWNER, workspace_id: WS },
  // Added after the invite: never assigned to the owner's row.
  { id: "house-b", manager_user_id: SERVICE_OWNER, workspace_id: WS },
  { id: "house-z", manager_user_id: SERVICE_OWNER, workspace_id: "other-ws" },
];

describe("owner of record -> owner portal access", () => {
  it("reads every house of the service workspace, including one added after the invite, on the owner defaults", async () => {
    const db = makeFakeDb({ account_link_invites: [ownerLink({})], manager_property_records: houses, profiles });
    const grants = await loadOwnerGrants(db, CLIENT);
    expect(grants).toHaveLength(1);
    expect(grants[0]!.managerUserId).toBe(SERVICE_OWNER);
    expect(grants[0]!.houses.map((h) => h.propertyId).sort()).toEqual(["house-a", "house-b"]);
    // Performance / statements / documents on, Messages off (the owner default), and never another workspace's house.
    expect(grants[0]!.houses.every((h) => h.performance && h.statements && h.documents && !h.messages)).toBe(true);
    expect(grantedHouses(grants, "performance").map((h) => h.propertyId)).not.toContain("house-z");
  });

  it("keeps a per-house key the team set (a house turned off stays off)", async () => {
    const db = makeFakeDb({
      account_link_invites: [
        ownerLink({
          assigned_property_ids: ["house-a", "house-b"],
          property_co_manager_permissions: {
            "house-a": { ownerPerformance: VIEW },
            "house-b": { ownerPerformance: { notification: false }, ownerStatements: { notification: false }, ownerDocuments: { notification: false } },
          },
        }),
      ],
      manager_property_records: houses,
      profiles,
    });
    const ids = grantedHouses(await loadOwnerGrants(db, CLIENT), "performance").map((h) => h.propertyId);
    expect(ids).toEqual(["house-a"]);
  });

  it("an ordinary owner (not the owner of record) still reads only the houses assigned to them", async () => {
    const db = makeFakeDb({
      account_link_invites: [ownerLink({ id: "link-2", invitee_user_id: REGULAR_OWNER, inviter_user_id: "manager-1", is_owner_of_record: false })],
      manager_property_records: houses.map((h) => ({ ...h, manager_user_id: "manager-1" })),
      profiles,
    });
    const grants = await loadOwnerGrants(db, REGULAR_OWNER);
    expect(grants[0]!.houses.map((h) => h.propertyId)).toEqual(["house-a"]);
  });

  it("a pending owner-of-record invite reads nothing until it is accepted", async () => {
    const db = makeFakeDb({ account_link_invites: [ownerLink({ status: "pending" })], manager_property_records: houses, profiles });
    expect(await loadOwnerGrants(db, CLIENT)).toEqual([]);
  });

  it("the owner of record with no portal of their own is owner-only: sign-in and Property portal land in the owner portal", async () => {
    const db = makeFakeDb({
      account_link_invites: [ownerLink({})],
      manager_property_records: houses,
      manager_purchases: [],
      profile_roles: [{ user_id: CLIENT, role: "manager" }],
      profiles,
    });
    expect(await ownerAccessStateFor(db, CLIENT)).toMatchObject({ hasOwnerAccess: true, ownerOnly: true });
  });

  it("an owner of record who also runs their own houses keeps the manager portal (and still has owner access)", async () => {
    const db = makeFakeDb({
      account_link_invites: [ownerLink({})],
      manager_property_records: [...houses, { id: "mine", manager_user_id: CLIENT, workspace_id: "my-ws" }],
      manager_purchases: [],
      profile_roles: [{ user_id: CLIENT, role: "manager" }],
      profiles,
    });
    expect(await ownerAccessStateFor(db, CLIENT)).toMatchObject({ hasOwnerAccess: true, ownerOnly: false });
  });

  it("an account with no owner row is unaffected", async () => {
    const db = makeFakeDb({
      account_link_invites: [ownerLink({})],
      manager_property_records: houses,
      manager_purchases: [],
      profile_roles: [{ user_id: "manager-1", role: "manager" }],
      profiles,
    });
    expect(await ownerAccessStateFor(db, "manager-1")).toEqual({ hasOwnerAccess: false, ownerOnly: false, messagesOn: false, financesOn: false });
    expect(await loadOwnerGrants(db, "manager-1")).toEqual([]);
  });
});

describe("a client who still OWNS an attached service workspace and is its owner of record", () => {
  const AMBIKA = "ambika-user";
  const OWN_WS = "ambika-ws";
  const tablesFor = (extra: Record<string, unknown[]> = {}) => ({
    platform_service_settings: [{ singleton: true, owner_user_id: SERVICE_OWNER }],
    portal_workspaces: [
      { id: OWN_WS, owner_user_id: AMBIKA, is_service: true },
      { id: "plain-ws", owner_user_id: SERVICE_OWNER, is_service: true },
      { id: "ordinary-ws", owner_user_id: REGULAR_OWNER, is_service: false },
    ],
    manager_property_records: [
      { id: "h1", manager_user_id: AMBIKA, workspace_id: OWN_WS },
      { id: "h2", manager_user_id: AMBIKA, workspace_id: OWN_WS },
    ],
    account_link_invites: [],
    manager_purchases: [{ id: "p1", user_id: AMBIKA }],
    profile_roles: [{ user_id: AMBIKA, role: "manager" }],
    profiles: [...profiles, { id: AMBIKA, email: "ambika@example.com" }],
    ...extra,
  });

  it("reads her own workspace's houses through the owner portal, on the owner defaults and never another's", async () => {
    const db = makeFakeDb(tablesFor() as never);
    const grants = await loadOwnerGrants(db, AMBIKA);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ managerUserId: AMBIKA });
    expect(grants[0]!.houses.map((h) => h.propertyId).sort()).toEqual(["h1", "h2"]);
    expect(grants[0]!.houses.every((h) => h.performance && h.statements && h.documents && !h.messages)).toBe(true);
  });

  it("lands in the owner portal (owner-only) even with a plan row, because PropLane Service runs the workspace", async () => {
    const db = makeFakeDb(tablesFor() as never);
    expect(await ownerAccessStateFor(db, AMBIKA)).toMatchObject({ hasOwnerAccess: true, ownerOnly: true, messagesOn: false });
  });

  it("keeps the manager portal when she also runs houses outside the service, holds a team seat elsewhere, or is a platform admin", async () => {
    const outside = makeFakeDb(
      tablesFor({ manager_property_records: [{ id: "h1", manager_user_id: AMBIKA, workspace_id: OWN_WS }, { id: "mine", manager_user_id: AMBIKA, workspace_id: "my-own-ws" }] }) as never,
    );
    expect(await ownerAccessStateFor(outside, AMBIKA)).toMatchObject({ hasOwnerAccess: true, ownerOnly: false });
    const seat = makeFakeDb(
      tablesFor({ account_link_invites: [{ id: "s", invitee_user_id: AMBIKA, inviter_user_id: "manager-1", status: "accepted", team_role: "viewer", workspace_id: "w" }] }) as never,
    );
    expect(await ownerAccessStateFor(seat, AMBIKA)).toMatchObject({ hasOwnerAccess: true, ownerOnly: false });
    const admin = makeFakeDb(tablesFor({ profile_roles: [{ user_id: AMBIKA, role: "manager" }, { user_id: AMBIKA, role: "admin" }] }) as never);
    expect(await ownerAccessStateFor(admin, AMBIKA)).toMatchObject({ hasOwnerAccess: true, ownerOnly: false });
  });

  it("the service owner (who owns the workspaces PropLane created) is never an owner of record, nor is an owner of an ordinary workspace", async () => {
    const db = makeFakeDb(tablesFor() as never);
    expect(await ownerAccessStateFor(db, SERVICE_OWNER)).toEqual({ hasOwnerAccess: false, ownerOnly: false, messagesOn: false, financesOn: false });
    expect(await loadOwnerGrants(db, SERVICE_OWNER)).toEqual([]);
    expect(await ownerAccessStateFor(db, REGULAR_OWNER)).toEqual({ hasOwnerAccess: false, ownerOnly: false, messagesOn: false, financesOn: false });
    expect(await loadOwnerGrants(db, REGULAR_OWNER)).toEqual([]);
  });

  it("fails closed (no owner access) when the service owner cannot be read", async () => {
    const db = makeFakeDb(tablesFor() as never, { errors: { platform_service_settings: { message: "boom" } } });
    expect(await ownerAccessStateFor(db, AMBIKA)).toEqual({ hasOwnerAccess: false, ownerOnly: false, messagesOn: false, financesOn: false });
  });

  it("an ordinary manager with a plan and houses is unaffected", async () => {
    const db = makeFakeDb(tablesFor() as never);
    expect(await ownerAccessStateFor(db, "manager-1")).toEqual({ hasOwnerAccess: false, ownerOnly: false, messagesOn: false, financesOn: false });
  });

  it("an existing Property owner (invited by a manager) is unchanged: grants from the membership, not the workspace flag", async () => {
    const db = makeFakeDb(
      tablesFor({
        account_link_invites: [ownerLink({ id: "l9", invitee_user_id: REGULAR_OWNER, inviter_user_id: "manager-1", is_owner_of_record: false, workspace_id: "ws-m" })],
        manager_property_records: [{ id: "house-a", manager_user_id: "manager-1", workspace_id: "ws-m" }],
      }) as never,
    );
    const grants = await loadOwnerGrants(db, REGULAR_OWNER);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ linkId: "l9", managerUserId: "manager-1" });
  });
});

describe("portal chooser for an owner-only account", () => {
  it("portal-roles reports ownerOnly from the owner membership, and the chooser names that entry Owner", () => {
    const route = read("src/app/api/auth/portal-roles/route.ts");
    expect(route).toMatch(/ownerAccessStateFor/);
    expect(route).toMatch(/ownerOnly/);
    const page = read("src/app/auth/choose-portal/page.tsx");
    expect(page).toMatch(/OWNER_ROLE_META/);
    expect(page).toMatch(/role === "manager" && ownerOnly/);
    // A multi-role account still gets the chooser: the role list is unchanged, only the label differs.
    expect(page).toMatch(/roles\.length !== 1|roles\?\.length !== 1|roles\?\.length === 1/);
  });
});
