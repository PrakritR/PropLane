/**
 * The household-charges incremental resync (`?updatedSince=`) only sees a row whose `updated_at`
 * moved. These writers used to change charge / rent-profile rows without bumping it.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/co-manager-notification.server", () => ({
  notifyPromotedToMainManager: vi.fn(),
  notifyDemotedToCoManager: vi.fn(),
}));

type Update = { table: string; payload: Record<string, unknown> };

/** Records every `.update()` payload; answers every read with an empty, error-free result. */
function recordingDb(queued: Record<string, unknown[]> = {}) {
  const updates: Update[] = [];
  const db = {
    from(table: string) {
      const self: Record<string, unknown> = {};
      const result = () => {
        const next = queued[table]?.shift();
        return { data: next ?? null, error: null };
      };
      for (const m of ["select", "eq", "is", "or", "in", "limit", "order", "insert", "upsert", "delete"]) self[m] = () => self;
      self.update = (payload: Record<string, unknown>) => {
        updates.push({ table, payload });
        return self;
      };
      self.maybeSingle = async () => result();
      self.single = async () => result();
      self.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve);
      return self;
    },
  };
  return { db: db as never, updates };
}

const stamped = (u: Update) => typeof u.payload.updated_at === "string" && Number.isFinite(Date.parse(u.payload.updated_at as string));

describe("charge-table writers bump updated_at", () => {
  it("migratePortalUserId: charges and rent profiles get updated_at, other tables are untouched", async () => {
    const { migratePortalUserId } = await import("@/lib/auth/migrate-portal-user-id");
    const { db, updates } = recordingDb();
    await migratePortalUserId(db, "from-user", "to-user");

    const synced = updates.filter((u) => u.table === "portal_household_charge_records" || u.table === "portal_recurring_rent_profile_records");
    // manager_user_id for both tables + resident_user_id for both tables
    expect(synced).toHaveLength(4);
    for (const u of synced) {
      expect(stamped(u)).toBe(true);
      expect(Object.keys(u.payload).sort()).toEqual(["updated_at", Object.keys(u.payload).find((k) => k !== "updated_at")!].sort());
    }
    expect(synced.map((u) => Object.keys(u.payload).find((k) => k !== "updated_at")).sort()).toEqual([
      "manager_user_id",
      "manager_user_id",
      "resident_user_id",
      "resident_user_id",
    ]);
    // A table without the guarantee keeps the exact old payload.
    const other = updates.find((u) => u.table === "manager_purchases");
    expect(other?.payload).toEqual({ user_id: "to-user" });
  });

  it("transferPropertyOwnership: charge and rent-profile rows get updated_at; other tables keep the old payload", async () => {
    const { transferPropertyOwnership } = await import("@/lib/property-ownership-transfer");
    const { db, updates } = recordingDb({
      manager_property_records: [
        { id: "prop-1", manager_user_id: "owner-1", property_data: { buildingName: "Bay House" } },
        { workspace_id: null },
      ],
      account_link_invites: [
        { id: "link-1", assigned_property_ids: ["prop-1", "prop-2"], property_co_manager_permissions: {}, co_manager_permissions: {} },
        { assigned_property_ids: ["prop-2"] },
        null,
      ],
    });
    const result = await transferPropertyOwnership(db, {
      propertyId: "prop-1",
      currentOwnerUserId: "owner-1",
      newManagerUserId: "new-1",
      formerOwnerPermissions: {},
    });
    expect(result.ok).toBe(true);

    for (const table of ["portal_household_charge_records", "portal_recurring_rent_profile_records"]) {
      const rows = updates.filter((u) => u.table === table);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.payload.manager_user_id).toBe("new-1");
      expect(stamped(rows[0]!)).toBe(true);
    }
    const lease = updates.find((u) => u.table === "portal_lease_pipeline_records");
    expect(lease?.payload).toEqual({ manager_user_id: "new-1" });
  });
});
