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
 *
 * `.select()` also supports the one-level-aliased JSON-path projection the
 * store uses for its narrowed reads (`value:row_data->operationsSettings->reminderRules`),
 * mirroring what PostgREST actually returns for a `col->seg->seg` select —
 * WS7 (egress): the store reads only the one namespace's value, not the
 * whole `row_data` blob, so the fake has to project that shape too.
 */
type Row = Record<string, unknown>;

function project(row: Row, cols: string): Row {
  const out: Row = {};
  for (const raw of cols.split(",").map((c) => c.trim()).filter(Boolean)) {
    const colonIdx = raw.indexOf(":");
    const alias = colonIdx >= 0 ? raw.slice(0, colonIdx) : null;
    const expr = colonIdx >= 0 ? raw.slice(colonIdx + 1) : raw;
    const segments = expr.split("->").map((s) => s.trim());
    const col = segments[0]!;
    let value: unknown = row[col];
    for (const seg of segments.slice(1)) {
      value = value && typeof value === "object" && !Array.isArray(value) ? (value as Row)[seg] : undefined;
    }
    out[alias ?? (segments.length > 1 ? segments[segments.length - 1]! : col)] = value;
  }
  return out;
}

function makeDb(tables: Record<string, Row[]>): SupabaseClient {
  return {
    from(table: string) {
      const rows = tables[table] ?? (tables[table] = []);
      const filters: Array<(r: Row) => boolean> = [];
      let mode: "select" | "update" = "select";
      let selectCols = "*";
      let updateObj: Row = {};
      const builder: Record<string, unknown> = {
        select(cols?: string) {
          mode = "select";
          selectCols = cols ?? "*";
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
          const projected = mode === "select" && match ? project(match, selectCols) : match;
          return Promise.resolve({ data: projected, error: null });
        },
        then(resolve: (v: { data: Row[] | null; error: null }) => unknown) {
          const matched = rows.filter((r) => filters.every((f) => f(r)));
          if (mode === "update") {
            for (const r of matched) Object.assign(r, updateObj);
            return resolve({ data: matched, error: null });
          }
          return resolve({ data: matched.map((r) => project(r, selectCols)), error: null });
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

describe("property overrides — savePropertyOverride merges, never replaces (PLAN-0916-1040 §1)", () => {
  it("a second save adds its own top-level keys without dropping the first's", async () => {
    const db = makeDb(seed());
    await savePropertyOverride(db, MGR, HOUSE_A, "reminderRules", { tour: { enabled: true } });
    await savePropertyOverride(db, MGR, HOUSE_A, "reminderRules", { lease: { enabled: false } });
    expect(await loadPropertyOverride(db, MGR, HOUSE_A, "reminderRules")).toEqual({
      tour: { enabled: true },
      lease: { enabled: false },
    });
  });

  it("saving the same key again overwrites only that key", async () => {
    const db = makeDb(seed());
    await savePropertyOverride(db, MGR, HOUSE_A, "reminderRules", { tour: { enabled: true }, lease: { enabled: false } });
    await savePropertyOverride(db, MGR, HOUSE_A, "reminderRules", { tour: { enabled: false } });
    expect(await loadPropertyOverride(db, MGR, HOUSE_A, "reminderRules")).toEqual({
      tour: { enabled: false },
      lease: { enabled: false },
    });
  });

  it("a per-kind save onto a legacy whole-blob override lifts the nested kinds to the top level first", async () => {
    const db = makeDb(seed());
    // Saved on `main` before per-kind overrides existed: every kind under `rules`.
    await savePropertyOverride(db, MGR, HOUSE_A, "reminderRules", {
      rules: { tour: { enabled: true }, lease: { enabled: true, timings: ["before:1440"] } },
      quietHours: { enabled: true, startHour: 21, endHour: 8 },
      automationSendMode: "auto",
    });
    await savePropertyOverride(db, MGR, HOUSE_A, "reminderRules", { lease: { enabled: false } });
    expect(await loadPropertyOverride(db, MGR, HOUSE_A, "reminderRules")).toEqual({
      tour: { enabled: true },
      lease: { enabled: false },
      quietHours: { enabled: true, startHour: 21, endHour: 8 },
      automationSendMode: "auto",
    });
  });

  it("an atomic namespace that always saves its whole shape still gets a full replace in effect", async () => {
    // lifecycleTasks and automatedMessages stay atomic: every caller always
    // passes the complete, already-normalized object, so the merge and a
    // whole replace land on the same stored value.
    const db = makeDb(seed());
    await savePropertyOverride(db, MGR, HOUSE_A, "lifecycleTasks", { review_application: { days: 2 }, collect_rent: { days: 1 } });
    await savePropertyOverride(db, MGR, HOUSE_A, "lifecycleTasks", { review_application: { days: 3 }, collect_rent: { days: 1 } });
    expect(await loadPropertyOverride(db, MGR, HOUSE_A, "lifecycleTasks")).toEqual({
      review_application: { days: 3 },
      collect_rent: { days: 1 },
    });
  });
});

describe("property overrides — clearPropertyOverride(kind) (PLAN-0916-1040 §1)", () => {
  it("clears one top-level key and leaves its siblings", async () => {
    const db = makeDb(seed());
    await savePropertyOverride(db, MGR, HOUSE_A, "reminderRules", { tour: { enabled: true }, lease: { enabled: false } });
    await clearPropertyOverride(db, MGR, HOUSE_A, "reminderRules", "tour");
    expect(await loadPropertyOverride(db, MGR, HOUSE_A, "reminderRules")).toEqual({ lease: { enabled: false } });
  });

  it("clearing a kind that was never set is a no-op", async () => {
    const db = makeDb(seed());
    await savePropertyOverride(db, MGR, HOUSE_A, "reminderRules", { tour: { enabled: true } });
    await clearPropertyOverride(db, MGR, HOUSE_A, "reminderRules", "lease");
    expect(await loadPropertyOverride(db, MGR, HOUSE_A, "reminderRules")).toEqual({ tour: { enabled: true } });
  });

  it("clears a kind nested under a legacy whole-blob override's own `rules` key", async () => {
    const db = makeDb(seed());
    // Simulate an override saved before per-kind partial overrides existed:
    // a full ReminderSettings-shaped blob with every kind under `rules`.
    await savePropertyOverride(db, MGR, HOUSE_A, "reminderRules", {
      rules: { tour: { enabled: true }, lease: { enabled: false } },
      quietHours: { enabled: true, startHour: 21, endHour: 8 },
    });
    await clearPropertyOverride(db, MGR, HOUSE_A, "reminderRules", "tour");
    expect(await loadPropertyOverride(db, MGR, HOUSE_A, "reminderRules")).toEqual({
      rules: { lease: { enabled: false } },
      quietHours: { enabled: true, startHour: 21, endHour: 8 },
    });
  });

  it("omitting kind still clears the whole namespace (unchanged behavior)", async () => {
    const db = makeDb(seed());
    await savePropertyOverride(db, MGR, HOUSE_A, "reminderRules", { tour: { enabled: true } });
    await clearPropertyOverride(db, MGR, HOUSE_A, "reminderRules");
    expect(await loadPropertyOverride(db, MGR, HOUSE_A, "reminderRules")).toBeNull();
  });
});
