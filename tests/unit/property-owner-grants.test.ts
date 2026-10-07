/**
 * `loadOwnerGrants` is the one place an owner's houses and permissions come
 * from. It reads the membership row, never a request, and a house is a grant
 * only when an owner key is on for it.
 */
import { describe, expect, it } from "vitest";

import { grantedHouses, loadOwnerGrants } from "@/lib/property-owner/access.server";
import { makeFakeDb } from "./property-owner-fake-db";

const OWNER = "owner-user";
const MANAGER = "manager-1";
const WS = "ws-1";
const ON = { read: true, notification: true };
const OFF = { notification: false };

function link(over: Record<string, unknown>) {
  return {
    id: "link-1",
    inviter_user_id: MANAGER,
    invitee_user_id: OWNER,
    status: "accepted",
    team_role: "property_owner",
    workspace_id: WS,
    house_scope: "selected",
    assigned_property_ids: ["house-a", "house-b"],
    co_manager_permissions: {},
    property_co_manager_permissions: {
      "house-a": { ownerPerformance: ON, ownerStatements: ON, ownerDocuments: ON, ownerMessages: OFF },
      "house-b": { ownerPerformance: OFF, ownerStatements: OFF, ownerDocuments: OFF, ownerMessages: OFF },
    },
    ...over,
  };
}

const houses = [
  { id: "house-a", manager_user_id: MANAGER, workspace_id: WS },
  { id: "house-b", manager_user_id: MANAGER, workspace_id: WS },
  { id: "house-c", manager_user_id: MANAGER, workspace_id: WS },
];
const profiles = [
  { id: OWNER, email: "dana@example.com" },
  { id: MANAGER, email: "manager@example.com" },
];

describe("loadOwnerGrants", () => {
  it("reaches only the houses with an owner key on, and reads the keys per house", async () => {
    const db = makeFakeDb({ account_link_invites: [link({})], manager_property_records: houses, profiles });
    const grants = await loadOwnerGrants(db, OWNER);
    expect(grants).toHaveLength(1);
    expect(grants[0]!.managerUserId).toBe(MANAGER);
    expect(grants[0]!.houses).toEqual([
      { propertyId: "house-a", performance: true, statements: true, documents: true, messages: false },
    ]);
  });

  it("never reaches a house that is assigned but off, nor an unassigned one in the same workspace", async () => {
    const db = makeFakeDb({ account_link_invites: [link({})], manager_property_records: houses, profiles });
    const ids = grantedHouses(await loadOwnerGrants(db, OWNER), "performance").map((h) => h.propertyId);
    expect(ids).toEqual(["house-a"]);
    expect(ids).not.toContain("house-b");
    expect(ids).not.toContain("house-c");
  });

  it("an All-houses owner reaches the workspace's houses, but only where the keys fall back to the role", async () => {
    const db = makeFakeDb({
      account_link_invites: [
        link({
          house_scope: "all",
          assigned_property_ids: ["house-a", "house-b", "house-c"],
          property_co_manager_permissions: { "house-b": { ownerPerformance: OFF } },
          co_manager_permissions: { ownerPerformance: ON, ownerStatements: ON, ownerDocuments: ON },
        }),
      ],
      manager_property_records: houses,
      profiles,
    });
    const grants = await loadOwnerGrants(db, OWNER);
    const ids = grants[0]!.houses.map((h) => h.propertyId).sort();
    // house-a and house-c fall back to the flat grant; house-b was set off explicitly.
    expect(ids).toEqual(["house-a", "house-c"]);
  });

  it("ignores everyone else's membership, a pending row, a non-owner role and a revoked owner", async () => {
    const db = makeFakeDb({
      account_link_invites: [
        link({ invitee_user_id: "someone-else" }),
        link({ id: "l2", status: "pending" }),
        link({ id: "l3", team_role: "viewer" }),
        link({ id: "l4", team_role: null }),
        link({ id: "l5", status: "cancelled" }),
      ],
      manager_property_records: houses,
      profiles,
    });
    expect(await loadOwnerGrants(db, OWNER)).toEqual([]);
  });

  it("does not reach a house the manager no longer owns (moved out of the workspace)", async () => {
    const db = makeFakeDb({
      account_link_invites: [link({})],
      manager_property_records: [{ id: "house-a", manager_user_id: "someone-else", workspace_id: WS }],
      profiles,
    });
    const grants = await loadOwnerGrants(db, OWNER);
    expect(grants[0]!.houses).toEqual([]);
  });
});
