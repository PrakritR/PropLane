import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ForeignPropertyError,
  clearPropertyOverride,
  listPropertyOverrides,
  loadPropertyOverride,
  loadPropertyOverridesForManagers,
  resolveOperationsOverride,
  savePropertyOverride,
} from "@/lib/settings/property-overrides.server";

/**
 * A tiny in-memory Supabase stand-in that supports exactly the chains the
 * override store uses: `.select().eq().eq().maybeSingle()`, an awaited
 * `.select().eq()` / `.select().in()`, and an awaited `.update().eq().eq()`.
 */
type Row = Record<string, unknown>;
function makeDb(tables: Record<string, Row[]>): SupabaseClient {
  return {
    from(table: string) {
      const rows = tables[table] ?? (tables[table] = []);
      const filters: Array<(r: Row) => boolean> = [];
      let mode: "select" | "update" = "select";
      let updateObj: Row = {};
      const builder: Record<string, unknown> = {
        select() {
          mode = "select";
          return builder;
        },
        update(obj: Row) {
          mode = "update";
          updateObj = obj;
          return builder;
        },
        eq(col: string, val: unknown) {
          filters.push((r) => String(r[col]) === String(val));
          return builder;
        },
        in(col: string, vals: unknown[]) {
          const set = new Set(vals.map(String));
          filters.push((r) => set.has(String(r[col])));
          return builder;
        },
        maybeSingle() {
          const match = rows.filter((r) => filters.every((f) => f(r)))[0] ?? null;
          return Promise.resolve({ data: match, error: null });
        },
        then(resolve: (v: { data: Row[] | null; error: null }) => unknown) {
          const matched = rows.filter((r) => filters.every((f) => f(r)));
          if (mode === "update") {
            for (const r of matched) Object.assign(r, updateObj);
            return resolve({ data: matched, error: null });
          }
          return resolve({ data: matched, error: null });
        },
      };
      return builder as never;
    },
  } as unknown as SupabaseClient;
}

const MGR = "mgr-1";
const HOUSE_A = "house-a";
const HOUSE_B = "house-b";

function seed(): Record<string, Row[]> {
  return {
    manager_property_records: [
      { id: HOUSE_A, manager_user_id: MGR, row_data: { title: "House A" } },
      { id: HOUSE_B, manager_user_id: MGR, row_data: { title: "House B" } },
      // A house owned by someone else — never visible to MGR.
      { id: "foreign-house", manager_user_id: "other-mgr", row_data: {} },
    ],
  };
}

const workspaceLoader = (value: { lead: number }) => ({
  loadWorkspace: async () => value,
  normalize: (raw: unknown) => (raw && typeof raw === "object" ? (raw as { lead: number }) : value),
});

describe("property overrides — resolve order", () => {
  it("propertyId null returns the workspace value (scope workspace, not inherited)", async () => {
    const db = makeDb(seed());
    const r = await resolveOperationsOverride(db, MGR, null, "reminderRules", workspaceLoader({ lead: 1 }));
    expect(r).toEqual({ settings: { lead: 1 }, scope: "workspace", inherited: false });
  });

  it("an un-customized house inherits the workspace value (inherited true)", async () => {
    const db = makeDb(seed());
    const r = await resolveOperationsOverride(db, MGR, HOUSE_A, "reminderRules", workspaceLoader({ lead: 1 }));
    expect(r).toEqual({ settings: { lead: 1 }, scope: "workspace", inherited: true });
  });

  it("a customized house returns its own override (scope property)", async () => {
    const db = makeDb(seed());
    await savePropertyOverride(db, MGR, HOUSE_A, "reminderRules", { lead: 2 });
    const r = await resolveOperationsOverride(db, MGR, HOUSE_A, "reminderRules", workspaceLoader({ lead: 1 }));
    expect(r).toEqual({ settings: { lead: 2 }, scope: "property", inherited: false });
  });
});

describe("property overrides — isolation & reset", () => {
  it("editing 'All properties' never rewrites a house override", async () => {
    const db = makeDb(seed());
    await savePropertyOverride(db, MGR, HOUSE_A, "reminderRules", { lead: 2 });
    // The workspace value changes to 5; the house keeps its own 2.
    const house = await resolveOperationsOverride(db, MGR, HOUSE_A, "reminderRules", workspaceLoader({ lead: 5 }));
    expect(house.settings).toEqual({ lead: 2 });
    // Another house still inherits the (new) workspace value.
    const other = await resolveOperationsOverride(db, MGR, HOUSE_B, "reminderRules", workspaceLoader({ lead: 5 }));
    expect(other).toEqual({ settings: { lead: 5 }, scope: "workspace", inherited: true });
  });

  it("reset drops the override and the house inherits the workspace again", async () => {
    const db = makeDb(seed());
    await savePropertyOverride(db, MGR, HOUSE_A, "reminderRules", { lead: 2 });
    expect(await loadPropertyOverride(db, MGR, HOUSE_A, "reminderRules")).toEqual({ lead: 2 });
    await clearPropertyOverride(db, MGR, HOUSE_A, "reminderRules");
    expect(await loadPropertyOverride(db, MGR, HOUSE_A, "reminderRules")).toBeNull();
    const r = await resolveOperationsOverride(db, MGR, HOUSE_A, "reminderRules", workspaceLoader({ lead: 1 }));
    expect(r.inherited).toBe(true);
  });

  it("namespaces are independent — clearing one leaves another", async () => {
    const db = makeDb(seed());
    await savePropertyOverride(db, MGR, HOUSE_A, "reminderRules", { lead: 2 });
    await savePropertyOverride(db, MGR, HOUSE_A, "lifecycleTasks", { lead: 9 });
    await clearPropertyOverride(db, MGR, HOUSE_A, "reminderRules");
    expect(await loadPropertyOverride(db, MGR, HOUSE_A, "reminderRules")).toBeNull();
    expect(await loadPropertyOverride(db, MGR, HOUSE_A, "lifecycleTasks")).toEqual({ lead: 9 });
  });
});

describe("property overrides — listing", () => {
  it("lists only houses that have their own override for a namespace", async () => {
    const db = makeDb(seed());
    await savePropertyOverride(db, MGR, HOUSE_A, "reminderRules", { lead: 2 });
    expect(await listPropertyOverrides(db, MGR, "reminderRules")).toEqual([HOUSE_A]);
    expect(await listPropertyOverrides(db, MGR, "lifecycleTasks")).toEqual([]);
  });

  it("loadPropertyOverridesForManagers keys manager -> property -> raw", async () => {
    const db = makeDb(seed());
    await savePropertyOverride(db, MGR, HOUSE_A, "reminderRules", { lead: 2 });
    const map = await loadPropertyOverridesForManagers(db, [MGR], "reminderRules");
    expect(map.get(MGR)?.get(HOUSE_A)).toEqual({ lead: 2 });
    expect(map.get(MGR)?.has(HOUSE_B)).toBe(false);
  });
});

describe("property overrides — ownership is fail-closed", () => {
  it("a foreign propertyId read is a ForeignPropertyError, never a workspace fallback", async () => {
    const db = makeDb(seed());
    await expect(loadPropertyOverride(db, MGR, "foreign-house", "reminderRules")).rejects.toBeInstanceOf(
      ForeignPropertyError,
    );
    await expect(resolveOperationsOverride(db, MGR, "foreign-house", "reminderRules", workspaceLoader({ lead: 1 }))).rejects.toBeInstanceOf(
      ForeignPropertyError,
    );
  });

  it("a foreign propertyId write throws before touching any row", async () => {
    const tables = seed();
    const db = makeDb(tables);
    await expect(savePropertyOverride(db, MGR, "foreign-house", "reminderRules", { lead: 2 })).rejects.toBeInstanceOf(
      ForeignPropertyError,
    );
    // The other manager's row is untouched.
    const foreign = tables.manager_property_records.find((r) => r.id === "foreign-house");
    expect(foreign?.row_data).toEqual({});
  });
});
