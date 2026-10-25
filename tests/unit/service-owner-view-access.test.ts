/**
 * The owner of record of a PropLane Service workspace sees EVERY house and module of that workspace, view only
 * (plan `service-owner-1025`, decision 4). The reach is derived at read time from the accepted seat's
 * `is_owner_of_record` flag and the workspace's `is_service` flag; nothing is written into the row, and the managed
 * read-only lock still refuses every write. A seat that is demoted, removed or on a non-service workspace gets none.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeServiceFakeDb, type ServiceFakeDb } from "../helpers/service-fake-db";

vi.mock("@/lib/manager-access-server", () => ({
  getEffectiveManagerSkuTier: vi.fn(async () => ({ ok: true, tier: "free" })),
}));

const OWNER = "11111111-1111-4111-8111-111111111111"; // PropLane service owner: owns the workspace
const CLIENT = "cccccccc-1111-4111-8111-cccccccccccc"; // the invited owner of record
const MANAGER = "dddddddd-1111-4111-8111-dddddddddddd"; // an ordinary self-serve manager
const SERVICE_WS = "aaaaaaaa-0000-4000-8000-000000000001";
const OWN_WS = "aaaaaaaa-0000-4000-8000-000000000002";
const SEAT = "eeeeeeee-0000-4000-8000-000000000001";

const OWNER_KEYS = { ownerPerformance: { read: true }, ownerStatements: { read: true } };

const seatMod = await import("@/lib/property-owner/service-owner-seat.server");
const { loadWorkspaces } = await import("@/lib/workspaces/server");
const scope = await import("@/lib/auth/manager-lease-scope");
const moduleScope = await import("@/lib/auth/co-manager-module-scope");
const readOnly = await import("@/lib/auth/managed-read-only.server");
const perms = await import("@/lib/co-manager-permissions");

let db: ServiceFakeDb;
const client = () => db as never;

function seed(seat: Record<string, unknown> = {}) {
  db = makeServiceFakeDb({
    platform_service_settings: [{ singleton: true, owner_user_id: OWNER }],
    profiles: [OWNER, CLIENT, MANAGER].map((id) => ({ id, email: `${id.slice(0, 4)}@example.com`, full_name: id.slice(0, 4) })),
    profile_roles: [{ user_id: CLIENT, role: "manager" }],
    manager_purchases: [],
    portal_workspaces: [
      { id: SERVICE_WS, owner_user_id: OWNER, name: "1. Ambika", is_default: true, is_service: true },
      { id: OWN_WS, owner_user_id: MANAGER, name: "Mine", is_default: true, is_service: false },
    ],
    manager_property_records: [
      { id: "house-a", manager_user_id: OWNER, workspace_id: SERVICE_WS, status: "live", row_data: { buildingName: "A" } },
      { id: "house-b", manager_user_id: OWNER, workspace_id: SERVICE_WS, status: "draft", row_data: { buildingName: "B" } },
      { id: "house-m", manager_user_id: MANAGER, workspace_id: OWN_WS, status: "live", row_data: { buildingName: "M" } },
      { id: "house-x", manager_user_id: OWNER, workspace_id: "another-workspace", status: "live", row_data: {} },
    ],
    account_link_invites: [
      {
        id: SEAT,
        inviter_user_id: OWNER,
        invitee_user_id: CLIENT,
        workspace_id: SERVICE_WS,
        status: "accepted",
        team_role: "property_owner",
        is_owner_of_record: true,
        // Stored: the owner keys on ONE house only, exactly what an owner invite writes.
        assigned_property_ids: ["house-a"],
        property_co_manager_permissions: { "house-a": OWNER_KEYS },
        co_manager_permissions: OWNER_KEYS,
        house_scope: "selected",
        workspace_permissions: {},
        ...seat,
      },
    ],
  });
}

beforeEach(() => seed());

describe("a service workspace's owner of record", () => {
  it("is derived every house of the workspace (a later-added one included), nothing from another workspace", async () => {
    db.tables.manager_property_records.push({ id: "house-late", manager_user_id: OWNER, workspace_id: SERVICE_WS, status: "live", row_data: {} });
    const seats = await seatMod.loadServiceOwnerSeats(client(), CLIENT);
    expect(seats).toHaveLength(1);
    expect(seats[0]!.assigned_property_ids.sort()).toEqual(["house-a", "house-b", "house-late"]);
    expect(seats[0]!.inviter_user_id).toBe(OWNER);
  });

  it("holds every module at view on every house, and never edit or delete", async () => {
    const [seat] = await seatMod.loadServiceOwnerSeats(client(), CLIENT);
    for (const id of seat!.assigned_property_ids) {
      for (const { id: module } of perms.CO_MANAGER_PERMISSION_OPTIONS) {
        expect(perms.coManagerModuleAllowed(seat!.property_co_manager_permissions, id, module, "read")).toBe(true);
        expect(perms.coManagerModuleAllowed(seat!.property_co_manager_permissions, id, module, "edit")).toBe(false);
        expect(perms.coManagerModuleAllowed(seat!.property_co_manager_permissions, id, module, "delete")).toBe(false);
      }
    }
  });

  it("writes nothing into the stored row", async () => {
    const before = JSON.stringify(db.tables.account_link_invites);
    await seatMod.loadServiceOwnerSeats(client(), CLIENT);
    await loadWorkspaces(client(), CLIENT);
    await scope.collectLinkedPropertyPermissionsForUser(client(), CLIENT);
    expect(JSON.stringify(db.tables.account_link_invites)).toBe(before);
  });

  it("lists the workspace with ALL its houses, read-only, with no way to add or manage", async () => {
    const workspaces = await loadWorkspaces(client(), CLIENT);
    const ws = workspaces.find((w) => w.id === SERVICE_WS)!;
    expect(ws).toBeTruthy();
    expect(ws.propertyIds.sort()).toEqual(["house-a", "house-b"]);
    expect(ws.readOnly).toBe(true);
    expect(ws.canAddProperties).toBe(false);
    expect(ws.canManageMembers).toBe(false);
    expect(ws.isService).toBe(true);
    expect(perms.coManagerModuleAllowed(ws.propertyPermissions, "house-b", "services", "read")).toBe(true);
    expect(perms.coManagerModuleAllowed(ws.propertyPermissions, "house-b", "services", "edit")).toBe(false);
  });

  it("reaches every house through the linked-property collectors, view only", async () => {
    const ids = await scope.collectLinkedPropertyIdsForUser(client(), CLIENT);
    expect([...ids].sort()).toEqual(["house-a", "house-b"]);
    const byProperty = await scope.collectLinkedPropertyPermissionsForUser(client(), CLIENT, { strict: true });
    for (const id of ["house-a", "house-b"]) {
      expect(perms.coManagerModuleAllowed(byProperty.get(id), id, "residents", "read")).toBe(true);
      expect(perms.coManagerModuleAllowed(byProperty.get(id), id, "payments", "read")).toBe(true);
      expect(perms.coManagerModuleAllowed(byProperty.get(id), id, "payments", "edit")).toBe(false);
    }
    const linked = await moduleScope.linkedPropertyIdsForModule(client(), CLIENT, "services");
    expect([...linked].sort()).toEqual(["house-a", "house-b"]);
    expect(await moduleScope.linkedOwnerForProperty(client(), CLIENT, "house-b")).toBe(OWNER);
    const read = await moduleScope.linkedOwnerScopeForModule(client(), CLIENT, "services", "read");
    expect([...read.propertyIds].sort()).toEqual(["house-a", "house-b"]);
    const edit = await moduleScope.linkedOwnerScopeForModule(client(), CLIENT, "services", "edit");
    expect(edit.propertyIds.size).toBe(0);
  });

  it("is still view-only for every write: the managed read-only lock covers the seat, the manager agent's check included", async () => {
    expect(await readOnly.managedReadOnlyWorkspaceIds(client(), CLIENT)).toEqual([SERVICE_WS]);
    expect(await readOnly.isManagedReadOnly(client(), CLIENT, SERVICE_WS)).toBe(true);
    // An unreadable lock counts as locked.
    db.failOn.account_link_invites = { code: "XX000", message: "boom" };
    expect(await readOnly.isManagedReadOnly(client(), CLIENT, SERVICE_WS)).toBe(true);
  });

  it("is not a teammate: the derived seat keeps the owner role, so the owner-link filter drops it from every teammate reader", async () => {
    const { withoutOwnerLinks } = await import("@/lib/co-manager-team-roles");
    const seats = await seatMod.loadServiceOwnerSeats(client(), CLIENT);
    expect(seats.every((seat) => seat.team_role === "property_owner")).toBe(true);
    expect(withoutOwnerLinks({ data: [...seats, ...db.tables.account_link_invites] }).data).toEqual([]);
  });
});

describe("what gets no wider access", () => {
  const nothing = async () => {
    expect(await seatMod.loadServiceOwnerSeats(client(), CLIENT)).toEqual([]);
    const ws = (await loadWorkspaces(client(), CLIENT)).find((w) => w.id === SERVICE_WS);
    expect(ws?.propertyIds ?? []).toEqual([]);
    expect([...(await scope.collectLinkedPropertyIdsForUser(client(), CLIENT))]).toEqual([]);
    expect((await scope.collectLinkedPropertyPermissionsForUser(client(), CLIENT)).size).toBe(0);
  };

  it("a property owner on a NON-service workspace keeps owner keys only: no houses, no modules", async () => {
    seed({ workspace_id: OWN_WS, inviter_user_id: MANAGER, is_owner_of_record: false, assigned_property_ids: ["house-m"], property_co_manager_permissions: { "house-m": OWNER_KEYS } });
    expect(await seatMod.loadServiceOwnerSeats(client(), CLIENT)).toEqual([]);
    const ws = (await loadWorkspaces(client(), CLIENT)).find((w) => w.id === OWN_WS)!;
    expect(ws.propertyIds).toEqual([]);
    expect(ws.readOnly).toBe(true);
    expect((await scope.collectLinkedPropertyPermissionsForUser(client(), CLIENT)).size).toBe(0);
    expect([...(await moduleScope.linkedPropertyIdsForModule(client(), CLIENT, "residents"))]).toEqual([]);
  });

  it("the same flagged seat on a workspace that is not (or no longer) a service workspace gets nothing", async () => {
    db.tables.portal_workspaces.find((w) => w.id === SERVICE_WS)!.is_service = false;
    expect(await seatMod.loadServiceOwnerSeats(client(), CLIENT)).toEqual([]);
    expect((await scope.collectLinkedPropertyPermissionsForUser(client(), CLIENT)).size).toBe(0);
  });

  it("a demoted owner (flag cleared) sees nothing", async () => {
    db.tables.account_link_invites[0]!.is_owner_of_record = false;
    await nothing();
  });

  it("a removed or not-yet-accepted owner sees nothing", async () => {
    db.tables.account_link_invites[0]!.status = "pending";
    await nothing();
    db.tables.account_link_invites.length = 0;
    await nothing();
  });

  it("a seat whose inviter is not the workspace's owner cannot be pointed at that workspace's houses", async () => {
    db.tables.account_link_invites[0]!.inviter_user_id = MANAGER;
    expect(await seatMod.loadServiceOwnerSeats(client(), CLIENT)).toEqual([]);
  });

  it("someone else's seat is not yours", async () => {
    expect(await seatMod.loadServiceOwnerSeats(client(), MANAGER)).toEqual([]);
    expect([...(await scope.collectLinkedPropertyIdsForUser(client(), MANAGER))]).toEqual([]);
  });

  it("an unreadable seat lookup fails closed: the strict gates throw, the workspace load throws, lists degrade to none", async () => {
    db.failOn.portal_workspaces = { code: "XX000", message: "boom" };
    await expect(seatMod.loadServiceOwnerSeats(client(), CLIENT, { strict: true })).rejects.toThrow();
    await expect(loadWorkspaces(client(), CLIENT)).rejects.toThrow();
    await expect(scope.collectLinkedPropertyPermissionsForUser(client(), CLIENT, { strict: true })).rejects.toThrow();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await scope.collectLinkedPropertyPermissionsForUser(client(), CLIENT)).size).toBe(0);
    errSpy.mockRestore();
  });
});
