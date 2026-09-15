import { describe, expect, it } from "vitest";
import { purgeOrphanHousingRecordsForManager } from "@/lib/auth/clear-property-housing-access";

type Row = Record<string, unknown>;

/**
 * The orphan sweep runs on every Applications load. A schedule row with no
 * property reference (the manager's task list, the planned-events singleton) is
 * an account-level record, not a stray from a deleted house — it must survive.
 */
function makeDb(scheduleRows: Row[]) {
  const deleted: Array<{ table: string; id: unknown }> = [];
  const db = {
    from(table: string) {
      return {
        select: () => ({
          eq: async () => ({ data: table === "portal_schedule_records" ? scheduleRows : [], error: null }),
        }),
        delete: () => ({
          eq: async (_col: string, id: unknown) => {
            deleted.push({ table, id });
            return { data: null, error: null };
          },
          in: async () => ({ data: null, error: null }),
        }),
      };
    },
    storage: { from: () => ({ list: async () => ({ data: [], error: null }), remove: async () => ({ data: null, error: null }) }) },
    _deleted: deleted,
  };
  return db;
}

describe("purgeOrphanHousingRecordsForManager · account-level schedule rows", () => {
  it("keeps the manager task list and the planned-events singleton, deletes an event for a gone house", async () => {
    const db = makeDb([
      { id: "axis_manager_tasks_v1_mgr-1", manager_user_id: "mgr-1", property_id: null, row_data: { recordType: "manager_tasks", tasks: [{ id: "t1", title: "Upload signed lease — Dana" }] } },
      { id: "axis_admin_planned_events_v1", manager_user_id: "mgr-1", property_id: null, row_data: { events: [] } },
      { id: "evt-gone", manager_user_id: "mgr-1", property_id: "prop-deleted", row_data: { propertyId: "prop-deleted" } },
      { id: "evt-live", manager_user_id: "mgr-1", property_id: "prop-live", row_data: { propertyId: "prop-live" } },
    ]);
    const result = await purgeOrphanHousingRecordsForManager(db as never, "mgr-1", new Set(["prop-live"]));
    const deletedIds = db._deleted.filter((d) => d.table === "portal_schedule_records").map((d) => d.id);
    expect(deletedIds).toEqual(["evt-gone"]);
    expect(result.recordsDeleted).toBe(1);
  });
});
