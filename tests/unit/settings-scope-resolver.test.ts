import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  resolveSettingsScope,
  saveWorkspaceNamespaceSettings,
  clearWorkspaceNamespaceSettings,
  listWorkspaceOverrides,
  createSettingsScopeCache,
} from "@/lib/settings/scope-resolver.server";
import { savePropertyOverride } from "@/lib/settings/property-overrides.server";

/**
 * A tiny in-memory Supabase stand-in, extending the pattern in
 * `settings-property-overrides.test.ts` with `.upsert()` support (for the
 * workspace row) and an optional per-table "relation does not exist" error,
 * to exercise the missing-migration fallback.
 */
type Row = Record<string, unknown>;

/**
 * Project a row through a PostgREST-style select string, including the
 * `alias:col->path->path` computed-column syntax `loadPropertyOverride`
 * (WS7 egress) uses — a plain column name is copied as-is.
 */
function projectSelect(row: Row, select?: string): Row {
  if (!select) return row;
  const result: Row = {};
  for (const part of select.split(",").map((s) => s.trim()).filter(Boolean)) {
    const aliasMatch = /^(\w+):(.+)$/.exec(part);
    if (aliasMatch) {
      const [, alias, pathExpr] = aliasMatch;
      const segments = pathExpr!.split("->").map((s) => s.trim());
      let value: unknown = row[segments[0]!];
      for (const seg of segments.slice(1)) {
        value = value && typeof value === "object" ? (value as Row)[seg] : undefined;
      }
      result[alias!] = value ?? null;
    } else {
      result[part] = row[part];
    }
  }
  return result;
}

function makeDb(tables: Record<string, Row[]>, missingTables: Set<string> = new Set()): SupabaseClient {
  return {
    from(table: string) {
      if (missingTables.has(table)) {
        const error = { code: "42P01", message: `relation "${table}" does not exist` };
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error }) }),
              maybeSingle: () => Promise.resolve({ data: null, error }),
              in: () => Promise.resolve({ data: null, error }),
            }),
            in: () => Promise.resolve({ data: null, error }),
          }),
          upsert: () => Promise.resolve({ error }),
          update: () => ({ eq: () => Promise.resolve({ error }) }),
        } as never;
      }
      const rows = tables[table] ?? (tables[table] = []);
      const filters: Array<(r: Row) => boolean> = [];
      let selectCols: string | undefined;
      const builder: Record<string, unknown> = {
        select(cols?: string) {
          selectCols = cols;
          return builder;
        },
        update(obj: Row) {
          const updateFilters: Array<(r: Row) => boolean> = [];
          const updateBuilder: Record<string, unknown> = {
            eq(col: string, val: unknown) {
              updateFilters.push((r) => String(r[col]) === String(val));
              return updateBuilder;
            },
            then(resolve: (v: { data: Row[] | null; error: null }) => unknown) {
              const matched = rows.filter((r) => updateFilters.every((f) => f(r)));
              for (const r of matched) Object.assign(r, obj);
              return resolve({ data: matched, error: null });
            },
          };
          return updateBuilder;
        },
        upsert(obj: Row, opts?: { onConflict?: string }) {
          const key = opts?.onConflict;
          const existing = key ? rows.find((r) => String(r[key]) === String(obj[key])) : undefined;
          if (existing) Object.assign(existing, obj);
          else rows.push({ ...obj });
          return Promise.resolve({ error: null });
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
          return Promise.resolve({ data: match ? projectSelect(match, selectCols) : null, error: null });
        },
        then(resolve: (v: { data: Row[] | null; error: null }) => unknown) {
          const matched = rows.filter((r) => filters.every((f) => f(r)));
          return resolve({ data: matched.map((r) => projectSelect(r, selectCols)), error: null });
        },
      };
      return builder as never;
    },
  } as unknown as SupabaseClient;
}

const MGR = "mgr-1";
const HOUSE_A = "house-a";
const WORKSPACE_1 = "workspace-1";

function seed(): Record<string, Row[]> {
  return {
    manager_property_records: [{ id: HOUSE_A, manager_user_id: MGR, workspace_id: WORKSPACE_1, row_data: {} }],
    workspace_automation_settings: [],
  };
}

const resolution = (accountValue: { lead: number }) => ({
  normalize: (raw: unknown) => (raw && typeof raw === "object" ? (raw as { lead: number }) : accountValue),
  loadAccount: async () => accountValue,
});

describe("resolveSettingsScope — resolution order", () => {
  it("no property or workspace resolves the account row (source: account)", async () => {
    const db = makeDb(seed());
    const r = await resolveSettingsScope(db, { managerUserId: MGR }, "reminderRules", resolution({ lead: 1 }));
    expect(r).toEqual({ value: { lead: 1 }, source: "account" });
  });

  it("a property override wins over everything (source: property)", async () => {
    const db = makeDb(seed());
    await savePropertyOverride(db, MGR, HOUSE_A, "reminderRules", { lead: 2 });
    const r = await resolveSettingsScope(db, { managerUserId: MGR, propertyId: HOUSE_A }, "reminderRules", resolution({ lead: 1 }));
    expect(r).toEqual({ value: { lead: 2 }, source: "property" });
  });

  it("no property override falls through to the workspace row, derived from the property (source: workspace)", async () => {
    const db = makeDb(seed());
    await saveWorkspaceNamespaceSettings(db, WORKSPACE_1, MGR, "reminderRules", { lead: 3 });
    const r = await resolveSettingsScope(db, { managerUserId: MGR, propertyId: HOUSE_A }, "reminderRules", resolution({ lead: 1 }));
    expect(r).toEqual({ value: { lead: 3 }, source: "workspace" });
  });

  it("an explicit workspaceId with no propertyId reads the workspace row directly", async () => {
    const db = makeDb(seed());
    await saveWorkspaceNamespaceSettings(db, WORKSPACE_1, MGR, "reminderRules", { lead: 3 });
    const r = await resolveSettingsScope(db, { managerUserId: MGR, workspaceId: WORKSPACE_1 }, "reminderRules", resolution({ lead: 1 }));
    expect(r).toEqual({ value: { lead: 3 }, source: "workspace" });
  });

  it("no rows anywhere resolves the account loader's value — today's behaviour, unchanged, pinned as source: account", async () => {
    const db = makeDb(seed());
    const r = await resolveSettingsScope(db, { managerUserId: MGR, propertyId: HOUSE_A }, "reminderRules", resolution({ lead: 1 }));
    expect(r).toEqual({ value: { lead: 1 }, source: "account" });
  });

  it("a namespace with no account loader resolves defaultValue (source: default)", async () => {
    const db = makeDb(seed());
    const r = await resolveSettingsScope(db, { managerUserId: MGR }, "reminderRules", {
      normalize: (raw: unknown) => (raw ?? { lead: 0 }) as { lead: number },
      defaultValue: { lead: 0 },
    });
    expect(r).toEqual({ value: { lead: 0 }, source: "default" });
  });

  it("a missing workspace_automation_settings table (42P01) is treated as no workspace row, never thrown", async () => {
    const db = makeDb(seed(), new Set(["workspace_automation_settings"]));
    const r = await resolveSettingsScope(db, { managerUserId: MGR, workspaceId: WORKSPACE_1 }, "reminderRules", resolution({ lead: 1 }));
    expect(r).toEqual({ value: { lead: 1 }, source: "account" });
  });

  it("a genuinely different database error still throws", async () => {
    const tables = seed();
    const db = makeDb(tables);
    // Poison the table's rows array with a getter that throws on filter — simulate an
    // unrelated failure by using a table name whose select().maybeSingle() errors non-42P01.
    const brokenDb = {
      from(table: string) {
        if (table === "workspace_automation_settings") {
          return {
            select: () => ({
              eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: { code: "53300", message: "too many connections" } }) }),
            }),
          };
        }
        return db.from(table);
      },
    } as unknown as SupabaseClient;
    await expect(
      resolveSettingsScope(brokenDb, { managerUserId: MGR, workspaceId: WORKSPACE_1 }, "reminderRules", resolution({ lead: 1 })),
    ).rejects.toBeTruthy();
  });
});

describe("resolveSettingsScope — per-request cache", () => {
  it("reuses a cached property→workspace lookup across calls sharing the same cache", async () => {
    const db = makeDb(seed());
    await saveWorkspaceNamespaceSettings(db, WORKSPACE_1, MGR, "reminderRules", { lead: 3 });
    const cache = createSettingsScopeCache();
    const first = await resolveSettingsScope(db, { managerUserId: MGR, propertyId: HOUSE_A }, "reminderRules", resolution({ lead: 1 }), cache);
    // Remove the property record entirely; a cache hit means resolution still finds the workspace.
    tablesDeleteProperty(db, HOUSE_A);
    const second = await resolveSettingsScope(db, { managerUserId: MGR, propertyId: HOUSE_A }, "reminderRules", resolution({ lead: 1 }), cache);
    expect(first.source).toBe("workspace");
    expect(second.source).toBe("workspace");
  });
});

function tablesDeleteProperty(db: SupabaseClient, propertyId: string): void {
  // Best-effort: the fake db keeps rows by closure, so directly mutate through a query.
  void db
    .from("manager_property_records")
    .update({ workspace_id: null })
    .eq("id", propertyId);
}

describe("workspace namespace storage — save, clear, list", () => {
  it("saves and clears one namespace on the workspace row without disturbing siblings", async () => {
    const db = makeDb(seed());
    await saveWorkspaceNamespaceSettings(db, WORKSPACE_1, MGR, "reminderRules", { lead: 3 });
    await saveWorkspaceNamespaceSettings(db, WORKSPACE_1, MGR, "lifecycleTasks", { lead: 9 });
    expect(await listWorkspaceOverrides(db, [WORKSPACE_1], "reminderRules")).toEqual([WORKSPACE_1]);
    await clearWorkspaceNamespaceSettings(db, WORKSPACE_1, "reminderRules");
    expect(await listWorkspaceOverrides(db, [WORKSPACE_1], "reminderRules")).toEqual([]);
    expect(await listWorkspaceOverrides(db, [WORKSPACE_1], "lifecycleTasks")).toEqual([WORKSPACE_1]);
  });

  it("listWorkspaceOverrides on a missing table returns an empty list, never throws", async () => {
    const db = makeDb(seed(), new Set(["workspace_automation_settings"]));
    expect(await listWorkspaceOverrides(db, [WORKSPACE_1], "reminderRules")).toEqual([]);
  });
});
