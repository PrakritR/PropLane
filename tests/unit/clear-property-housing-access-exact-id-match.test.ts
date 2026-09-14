/**
 * `clearHousingAccessForDeletedProperty` runs with the SERVICE-ROLE client and
 * rewrites `account_link_invites` / `portal_pro_relationship_records` and
 * DELETES housing rows (applications, leases, charges, …) across EVERY manager.
 * It used to match ids through a normalizing token, which made one manager's id
 * fold onto another's.
 *
 * That turned "delete my own listing" into a cross-manager primitive.
 * Ids now match EXACTLY. A colliding suffix must not delete the victim's
 * residents, leases, or grants.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearHousingAccessForDeletedProperty,
  purgeOrphanHousingRecordsForManager,
} from "@/lib/auth/clear-property-housing-access";

const VICTIM_PROPERTY = "mgr-victim-house-1";
/** The attacker's own listing id. Differs by one trailing character. */
const COLLIDING_PROPERTY = "mgr-victim-house-1.";
const BYSTANDER_PROPERTY = "mgr-bystander-house-7";

type InviteRow = {
  id: string;
  assigned_property_ids: string[];
  property_co_manager_permissions: Record<string, unknown>;
};
type AppRow = {
  id: string;
  manager_user_id?: string;
  property_id: string | null;
  assigned_property_id: string | null;
  row_data: Record<string, unknown>;
};
type RelRow = { id: string; row_data: Record<string, unknown> };
type LeaseRow = { id: string; manager_user_id?: string; property_id: string | null; row_data?: Record<string, unknown> };
type ChargeRow = { id: string; manager_user_id?: string; property_id: string | null; row_data?: Record<string, unknown> };

let invites: InviteRow[] = [];
let apps: AppRow[] = [];
let rels: RelRow[] = [];
let leases: LeaseRow[] = [];
let charges: ChargeRow[] = [];
const emptyTables = new Map<string, Array<{ id: string }>>();

function seed() {
  invites = [
    {
      id: "invite-victim-co-manager",
      assigned_property_ids: [VICTIM_PROPERTY, BYSTANDER_PROPERTY],
      property_co_manager_permissions: {
        [VICTIM_PROPERTY]: { properties: "edit" },
        [BYSTANDER_PROPERTY]: { properties: "view" },
      },
    },
  ];
  apps = [
    {
      id: "app-victim-resident",
      manager_user_id: "mgr-victim",
      property_id: null,
      assigned_property_id: null,
      row_data: {
        property: "12 Victim Way · 4 rooms",
        propertyId: VICTIM_PROPERTY,
        assignedRoomChoice: "Room 2",
        stage: "Approved",
      },
    },
    {
      id: "app-bystander-resident",
      manager_user_id: "mgr-victim",
      property_id: null,
      assigned_property_id: null,
      row_data: { propertyId: BYSTANDER_PROPERTY, stage: "Approved" },
    },
    {
      id: "app-column-resident",
      manager_user_id: "mgr-other",
      property_id: VICTIM_PROPERTY,
      assigned_property_id: null,
      row_data: { propertyId: VICTIM_PROPERTY, stage: "Approved" },
    },
  ];
  rels = [
    {
      id: "rel-victim-co-manager",
      row_data: {
        assignedPropertyIds: [VICTIM_PROPERTY, BYSTANDER_PROPERTY],
        propertyCoManagerPermissions: {
          [VICTIM_PROPERTY]: { properties: "edit" },
          [BYSTANDER_PROPERTY]: { properties: "view" },
        },
      },
    },
  ];
  leases = [
    { id: "lease-victim", manager_user_id: "mgr-victim", property_id: VICTIM_PROPERTY },
    { id: "lease-bystander", manager_user_id: "mgr-victim", property_id: BYSTANDER_PROPERTY },
  ];
  charges = [
    { id: "charge-victim", manager_user_id: "mgr-victim", property_id: VICTIM_PROPERTY },
    { id: "charge-bystander", manager_user_id: "mgr-victim", property_id: BYSTANDER_PROPERTY },
  ];
  emptyTables.clear();
}

type Filters = { eq: Array<[string, unknown]>; is: Array<[string, unknown]> };

function query(resolve: (filters: Filters) => { data: unknown[] | null; error: null }) {
  const filters: Filters = { eq: [], is: [] };
  const chain = {
    eq(column: string, value: unknown) {
      filters.eq.push([column, value]);
      return chain;
    },
    is(column: string, value: unknown) {
      filters.is.push([column, value]);
      return chain;
    },
    limit() {
      return chain;
    },
    then(onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
      return Promise.resolve(resolve(filters)).then(onFulfilled, onRejected);
    },
  };
  return chain;
}

function matchesFilters(row: Record<string, unknown>, filters: Filters): boolean {
  for (const [column, value] of filters.eq) {
    if (row[column] !== value) return false;
  }
  for (const [column, value] of filters.is) {
    if (row[column] !== value) return false;
  }
  return true;
}

function updateBy<T extends { id: string }>(rows: T[], patch: Record<string, unknown>) {
  return {
    eq: async (_column: string, value: string) => {
      const row = rows.find((candidate) => candidate.id === value);
      if (row) Object.assign(row, patch);
      return { error: null };
    },
  };
}

function deleteFrom<T extends Record<string, unknown>>(rows: T[]) {
  return {
    eq: async (column: string, value: string) => {
      const keep = rows.filter((row) => row[column] !== value);
      rows.length = 0;
      rows.push(...keep);
      return { error: null };
    },
  };
}

function emptyStore(table: string): Array<{ id: string } & Record<string, unknown>> {
  if (!emptyTables.has(table)) emptyTables.set(table, []);
  return emptyTables.get(table) as Array<{ id: string } & Record<string, unknown>>;
}

/** A Supabase-shaped stub whose SELECT filters behave like the real database:
 *  `.eq` is an exact column comparison, so only the helper's own id matching is
 *  under test. Unknown tables start empty so cascade deletes stay isolated. */
const db = {
  from(table: string) {
    if (table === "account_link_invites") {
      return {
        select: () => query(() => ({ data: invites, error: null })),
        update: (patch: Record<string, unknown>) => updateBy(invites, patch),
        delete: () => deleteFrom(invites as unknown as Array<Record<string, unknown>>),
      };
    }
    if (table === "manager_application_records") {
      return {
        select: () =>
          query((filters) => ({
            data: apps.filter((row) => matchesFilters(row as unknown as Record<string, unknown>, filters)),
            error: null,
          })),
        update: (patch: Record<string, unknown>) => updateBy(apps, patch),
        delete: () => deleteFrom(apps as unknown as Array<Record<string, unknown>>),
      };
    }
    if (table === "portal_pro_relationship_records") {
      return {
        select: () => query(() => ({ data: rels, error: null })),
        update: (patch: Record<string, unknown>) => updateBy(rels, patch),
        delete: () => deleteFrom(rels as unknown as Array<Record<string, unknown>>),
      };
    }
    if (table === "portal_lease_pipeline_records") {
      return {
        select: () =>
          query((filters) => ({
            data: leases.filter((row) => matchesFilters(row as unknown as Record<string, unknown>, filters)),
            error: null,
          })),
        delete: () => deleteFrom(leases as unknown as Array<Record<string, unknown>>),
      };
    }
    if (table === "portal_household_charge_records") {
      return {
        select: () =>
          query((filters) => ({
            data: charges.filter((row) => matchesFilters(row as unknown as Record<string, unknown>, filters)),
            error: null,
          })),
        delete: () => deleteFrom(charges as unknown as Array<Record<string, unknown>>),
      };
    }
    const rows = emptyStore(table);
    return {
      select: () =>
        query((filters) => ({
          data: rows.filter((row) => matchesFilters(row, filters)),
          error: null,
        })),
      update: (patch: Record<string, unknown>) => updateBy(rows, patch),
      delete: () => deleteFrom(rows),
    };
  },
} as unknown as Parameters<typeof clearHousingAccessForDeletedProperty>[0];

const victimInvite = () => invites.find((row) => row.id === "invite-victim-co-manager")!;
const victimApp = () => apps.find((row) => row.id === "app-victim-resident");
const victimRel = () => rels.find((row) => row.id === "rel-victim-co-manager")!;

beforeEach(seed);

describe("clearHousingAccessForDeletedProperty — a colliding id must not reach the victim", () => {
  it("leaves the victim's co-manager grant intact when the attacker deletes mgr-victim-house-1.", async () => {
    await clearHousingAccessForDeletedProperty(db, COLLIDING_PROPERTY);

    expect(victimInvite().assigned_property_ids).toEqual([VICTIM_PROPERTY, BYSTANDER_PROPERTY]);
    expect(victimInvite().property_co_manager_permissions).toEqual({
      [VICTIM_PROPERTY]: { properties: "edit" },
      [BYSTANDER_PROPERTY]: { properties: "view" },
    });
  });

  it("does not delete the victim's resident", async () => {
    await clearHousingAccessForDeletedProperty(db, COLLIDING_PROPERTY);

    expect(victimApp()?.row_data.stage).toBe("Approved");
    expect(victimApp()?.row_data.propertyId).toBe(VICTIM_PROPERTY);
    expect(victimApp()?.row_data.property).toBe("12 Victim Way · 4 rooms");
    expect(victimApp()?.row_data.assignedRoomChoice).toBe("Room 2");
  });

  it("does not delete the victim's lease or charge", async () => {
    await clearHousingAccessForDeletedProperty(db, COLLIDING_PROPERTY);

    expect(leases.map((row) => row.id)).toEqual(["lease-victim", "lease-bystander"]);
    expect(charges.map((row) => row.id)).toEqual(["charge-victim", "charge-bystander"]);
  });

  it("does not clear the victim's pro-relationship property assignments", async () => {
    await clearHousingAccessForDeletedProperty(db, COLLIDING_PROPERTY);

    expect(victimRel().row_data.assignedPropertyIds).toEqual([VICTIM_PROPERTY, BYSTANDER_PROPERTY]);
    expect(victimRel().row_data.propertyCoManagerPermissions).toEqual({
      [VICTIM_PROPERTY]: { properties: "edit" },
      [BYSTANDER_PROPERTY]: { properties: "view" },
    });
  });

  it("reports that it changed nothing", async () => {
    const result = await clearHousingAccessForDeletedProperty(db, COLLIDING_PROPERTY);

    expect(result.invitesUpdated).toBe(0);
    expect(result.applicationsCleared).toBe(0);
    expect(result.recordsDeleted).toBe(0);
  });
});

describe("clearHousingAccessForDeletedProperty — the exact id still cleans up", () => {
  it("strips the deleted property from the invite grant and keeps the others", async () => {
    const result = await clearHousingAccessForDeletedProperty(db, VICTIM_PROPERTY);

    expect(victimInvite().assigned_property_ids).toEqual([BYSTANDER_PROPERTY]);
    expect(victimInvite().property_co_manager_permissions).toEqual({
      [BYSTANDER_PROPERTY]: { properties: "view" },
    });
    expect(result.invitesUpdated).toBe(1);
  });

  it("deletes the legacy row_data-only application instead of leaving a Moved-out ghost", async () => {
    const result = await clearHousingAccessForDeletedProperty(db, VICTIM_PROPERTY);

    expect(victimApp()).toBeUndefined();
    expect(apps.find((row) => row.id === "app-column-resident")).toBeUndefined();
    expect(result.applicationsCleared).toBe(2);
  });

  it("deletes leases and charges for that property only", async () => {
    await clearHousingAccessForDeletedProperty(db, VICTIM_PROPERTY);

    expect(leases.map((row) => row.id)).toEqual(["lease-bystander"]);
    expect(charges.map((row) => row.id)).toEqual(["charge-bystander"]);
  });

  it("clears the pro-relationship assignment for that property only", async () => {
    await clearHousingAccessForDeletedProperty(db, VICTIM_PROPERTY);

    expect(victimRel().row_data.assignedPropertyIds).toEqual([BYSTANDER_PROPERTY]);
    expect(victimRel().row_data.propertyCoManagerPermissions).toEqual({
      [BYSTANDER_PROPERTY]: { properties: "view" },
    });
  });

  it("leaves an unrelated resident on another property untouched", async () => {
    await clearHousingAccessForDeletedProperty(db, VICTIM_PROPERTY);

    const bystander = apps.find((row) => row.id === "app-bystander-resident")!;
    expect(bystander.row_data.stage).toBe("Approved");
    expect(bystander.row_data.propertyId).toBe(BYSTANDER_PROPERTY);
  });
});

describe("purgeOrphanHousingRecordsForManager", () => {
  it("deletes this manager's residents, leases, and charges when the house is gone", async () => {
    const result = await purgeOrphanHousingRecordsForManager(
      db,
      "mgr-victim",
      new Set([BYSTANDER_PROPERTY]),
    );

    expect(apps.find((row) => row.id === "app-victim-resident")).toBeUndefined();
    expect(apps.find((row) => row.id === "app-bystander-resident")).toBeDefined();
    expect(leases.map((row) => row.id)).toEqual(["lease-bystander"]);
    expect(charges.map((row) => row.id)).toEqual(["charge-bystander"]);
    expect(result.applicationsCleared).toBe(1);
  });

  it("deletes every housing row for the manager when they have no live properties", async () => {
    const result = await purgeOrphanHousingRecordsForManager(db, "mgr-victim", new Set());

    expect(apps.filter((row) => row.manager_user_id === "mgr-victim")).toEqual([]);
    expect(leases).toEqual([]);
    expect(charges).toEqual([]);
    expect(result.applicationsCleared).toBe(2);
  });
});
