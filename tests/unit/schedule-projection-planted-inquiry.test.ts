/**
 * A standalone inquiry/tour row is free-form (any manager can write one through the generic upsert), so its
 * payload house is a claim. Staff and co-managers see it only when the house's owner, an eligible tour host of that
 * house (an assigned co-manager with Calendar/Applications edit, or the platform operator of a PropLane-managed house),
 * or the server wrote it, and the column house agrees with the payload. The host roster is read from the database
 * tables themselves (faked below), never from the row.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const scope = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("@/lib/auth/co-manager-module-scope", () => ({ linkedOwnerScopeForModule: scope.fn }));

import { projectScheduleRecordsForViewer, tourHostIdsByHouse } from "@/lib/schedule-record-projection.server";

type Row = Record<string, unknown>;

const OWNER = "owner-1";
const ATTACKER = "attacker-1";
const CO_HOST = "co-host-b";
const OPERATOR = "operator-1";
const HOUSE = "house-1";
const WS = "ws-1";
const STAFF = { id: "staff-1", role: "manager", serviceScope: { propertyIds: [HOUSE] } };
const COMANAGER = { id: "co-1", role: "manager" };

const world = {
  managed: true,
  failing: new Set<string>(),
  houses: [] as Row[],
  calls: [] as string[],
};

function tables(): Record<string, Row[]> {
  return {
    manager_property_records: world.houses,
    portal_workspaces: [{ id: WS, owner_user_id: OWNER, is_default: true, is_service: world.managed }],
    account_link_invites: [
      {
        inviter_user_id: OWNER,
        invitee_user_id: CO_HOST,
        status: "accepted",
        assigned_property_ids: world.houses.map((house) => house.id),
        property_co_manager_permissions: Object.fromEntries(
          world.houses.map((house) => [house.id, { calendar: { read: true, edit: true } }]),
        ),
      },
    ],
    platform_service_settings: [{ singleton: true, owner_user_id: OPERATOR }],
  };
}

/** A PostgREST-shaped fake: `in` / `eq` filters over the table rows above; a failing table answers an error. */
const db = {
  from(table: string) {
    world.calls.push(table);
    const filters: Array<(row: Row) => boolean> = [];
    const answer = () => {
      if (world.failing.has(table)) return { data: null, error: { message: `${table} down`, code: "PGRST002" } };
      return { data: (tables()[table] ?? []).filter((row) => filters.every((f) => f(row))), error: null };
    };
    const q: Record<string, unknown> = {
      select: () => q,
      in: (column: string, values: unknown[]) => (filters.push((row) => values.includes(row[column])), q),
      eq: (column: string, value: unknown) => (filters.push((row) => row[column] === value), q),
      maybeSingle: async () => {
        const result = answer();
        return { data: result.data?.[0] ?? null, error: result.error };
      },
      then: (resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) =>
        Promise.resolve(answer()).then(resolve, reject),
    };
    return q;
  },
} as never;

const row = (id: string, manager: string | null, column: string | null, payloadHouse = HOUSE) => ({
  id,
  manager_user_id: manager,
  property_id: column,
  record_type: "partner_inquiry_request",
  row_data: { id, recordType: "partner_inquiry_request", payload: { id, kind: "tour", status: "pending", propertyId: payloadHouse, name: "X" } },
});

const ids = async (user: Record<string, unknown>, rows: Record<string, unknown>[], options = {}) =>
  (await projectScheduleRecordsForViewer(db, user as never, rows, options)).map((r) => r.id);

beforeEach(() => {
  world.managed = true;
  world.failing = new Set();
  world.houses = [{ id: HOUSE, manager_user_id: OWNER, workspace_id: WS }];
  world.calls = [];
  scope.fn.mockReset().mockImplementation(async () => ({
    ownerIds: new Set(),
    propertyIds: new Set(),
    propertyIdsByOwner: new Map([[OWNER, new Set([HOUSE])]]),
  }));
});

describe("planted standalone inquiries", () => {
  it("staff do not see a row an unrelated manager planted on a staff house", async () => {
    expect(await ids(STAFF, [row("planted", ATTACKER, HOUSE)])).toEqual([]);
  });
  it("a co-manager with a grant gets neither a full nor a busy copy of a planted row", async () => {
    expect(await ids(COMANAGER, [row("planted", ATTACKER, null)])).toEqual([]);
  });
  it("a genuine row written by the house owner (or the server) still reaches staff and the co-manager", async () => {
    expect(await ids(STAFF, [row("own", OWNER, HOUSE), row("server", null, HOUSE)])).toEqual(["own", "server"]);
    expect(await ids(COMANAGER, [row("own", OWNER, HOUSE)])).toEqual(["own"]);
  });
  it("a slot tour hosted by co-manager B or the managed-workspace operator reaches staff and other co-managers", async () => {
    const rows = [row("by-co-host", CO_HOST, HOUSE), row("by-operator", OPERATOR, HOUSE)];
    expect(await ids(STAFF, rows)).toEqual(["by-co-host", "by-operator"]);
    expect(await ids(COMANAGER, rows)).toEqual(["by-co-host", "by-operator"]);
  });
  it("on a self-serve house the operator is not a host, and a planted row stays dropped", async () => {
    world.managed = false;
    const rows = [row("by-operator", OPERATOR, HOUSE), row("planted", ATTACKER, HOUSE), row("by-co-host", CO_HOST, HOUSE)];
    expect(await ids(COMANAGER, rows)).toEqual(["by-co-host"]);
  });
  it("a strict read fails loud when the host roster is unreadable", async () => {
    world.failing.add("account_link_invites");
    await expect(ids(COMANAGER, [row("by-co-host", CO_HOST, HOUSE)], { throwOnError: true })).rejects.toThrow();
  });
  it("a strict read fails loud when the managed-workspace or operator read fails, never drops the operator's row", async () => {
    for (const table of ["portal_workspaces", "platform_service_settings"]) {
      world.failing = new Set([table]);
      await expect(ids(COMANAGER, [row("by-operator", OPERATOR, HOUSE)], { throwOnError: true })).rejects.toThrow();
    }
    world.failing = new Set(["platform_service_settings"]);
    await expect(ids(STAFF, [row("by-operator", OPERATOR, HOUSE)], { throwOnError: true })).rejects.toThrow();
  });
  it("a non-strict read narrows instead: the operator's row is dropped, nothing throws", async () => {
    world.failing = new Set(["portal_workspaces"]);
    expect(await ids(COMANAGER, [row("by-operator", OPERATOR, HOUSE)])).toEqual([]);
  });
  it("drops a row whose column property differs from the payload house", async () => {
    expect(await ids(STAFF, [row("mismatch", OWNER, "other-house")])).toEqual([]);
  });
  it("the writer still reads their own row", async () => {
    const own = row("mine", ATTACKER, HOUSE);
    (own.row_data.payload as Record<string, unknown>).managerUserId = ATTACKER;
    expect(await ids({ id: ATTACKER, role: "manager" }, [own])).toEqual(["mine"]);
  });
});

describe("tourHostIdsByHouse", () => {
  const owners = (count: number) => {
    world.houses = Array.from({ length: count }, (_, i) => ({ id: `house-${i}`, manager_user_id: OWNER, workspace_id: WS }));
    return new Map(world.houses.map((house) => [String(house.id), OWNER]));
  };

  it("reads the same number of tables for one house as for fifteen", async () => {
    await tourHostIdsByHouse(db, owners(1), { throwOnError: true });
    const one = world.calls.length;
    world.calls = [];
    const many = await tourHostIdsByHouse(db, owners(15), { throwOnError: true });
    expect(world.calls.length).toBe(one);
    expect([...many.values()].every((hosts) => hosts.has(OWNER) && hosts.has(CO_HOST) && hosts.has(OPERATOR))).toBe(true);
  });

  it("houses already known to be managed skip the workspace reads entirely", async () => {
    const map = owners(15);
    const hosts = await tourHostIdsByHouse(db, map, { throwOnError: true, managedHouses: new Set(map.keys()) });
    expect(world.calls).not.toContain("portal_workspaces");
    expect(world.calls.filter((table) => table === "account_link_invites")).toHaveLength(1);
    expect(hosts.get("house-3")).toEqual(new Set([OWNER, CO_HOST, OPERATOR]));
  });
});
