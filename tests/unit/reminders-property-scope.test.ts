import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DEFAULT_REMINDER_SETTINGS,
  normalizeReminderSettings,
  type ReminderSettings,
} from "@/lib/reminders/rules";
import {
  loadReminderSettingsForProperty,
  loadReminderSettingsResolver,
  mergeReminderSettingsOverride,
} from "@/lib/reminders/settings.server";

/**
 * Minimal in-memory Supabase supporting the resolver's `.select().in()` reads,
 * including the one-level-aliased JSON-path projection the override store
 * uses for its narrowed reads (`value:row_data->operationsSettings->reminderRules`,
 * WS7 egress) — mirrors what PostgREST actually returns for a `col->seg->seg`
 * select.
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
        then(resolve: (v: { data: Row[]; error: null }) => unknown) {
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
const BALLARD = "ballard";
const CASCADE = "cascade";

/** Workspace: inspection reminds 1 day before (the built-in default). */
const workspace: ReminderSettings = normalizeReminderSettings(DEFAULT_REMINDER_SETTINGS);

/** Ballard House's own override: inspection reminds 2 days before. */
const ballardOverride: ReminderSettings = normalizeReminderSettings({
  ...workspace,
  rules: {
    ...workspace.rules,
    inspection: { ...workspace.rules.inspection, timings: ["before:2880", "after:1440", "after:10080"] },
  },
});

const beforeTimings = (s: ReminderSettings) => s.rules.inspection.timings.filter((t) => t.startsWith("before:"));

describe("reminder senders resolve per house", () => {
  it("two houses, two rules -> two timings from one resolver load", async () => {
    const db = makeDb({
      manager_automation_settings: [{ manager_user_id: MGR, row_data: { reminderRules: workspace } }],
      manager_property_records: [
        // Ballard House is customized; Cascade Lofts is not.
        { id: BALLARD, manager_user_id: MGR, row_data: { operationsSettings: { reminderRules: ballardOverride } } },
        { id: CASCADE, manager_user_id: MGR, row_data: {} },
      ],
    });

    const resolver = await loadReminderSettingsResolver(db, [MGR]);

    // A Ballard House lease resolves to Ballard House's rule: 2 days before.
    expect(beforeTimings(resolver.resolve(MGR, BALLARD))).toEqual(["before:2880"]);
    // A Cascade Lofts lease inherits the workspace rule: 1 day before.
    expect(beforeTimings(resolver.resolve(MGR, CASCADE))).toEqual(["before:1440"]);
  });

  it("a row with no property keeps the workspace rule", async () => {
    const db = makeDb({
      manager_automation_settings: [{ manager_user_id: MGR, row_data: { reminderRules: workspace } }],
      manager_property_records: [
        { id: BALLARD, manager_user_id: MGR, row_data: { operationsSettings: { reminderRules: ballardOverride } } },
      ],
    });
    const resolver = await loadReminderSettingsResolver(db, [MGR]);
    // e.g. an unanswered inbox thread has no property → workspace rule.
    expect(beforeTimings(resolver.resolve(MGR, null))).toEqual(["before:1440"]);
  });

  it("a manager with no stored row falls back to defaults, never silence", async () => {
    const db = makeDb({ manager_automation_settings: [], manager_property_records: [] });
    const resolver = await loadReminderSettingsResolver(db, [MGR]);
    expect(beforeTimings(resolver.resolve(MGR, null))).toEqual(beforeTimings(DEFAULT_REMINDER_SETTINGS));
  });
});

describe("mergeReminderSettingsOverride — per-kind partial (PLAN-0916-1040 §1)", () => {
  it("a bare per-kind partial changes only the named kinds; every other kind is the WORKSPACE value verbatim", () => {
    const partial = { inspection: { ...workspace.rules.inspection, timings: ["before:2880"] } };
    const merged = mergeReminderSettingsOverride(workspace, partial);
    expect(merged.rules.inspection.timings).toEqual(["before:2880"]);
    // Every kind this house never customized is the SAME object shape the
    // workspace produced — not a snapshot frozen at override time.
    expect(merged.rules.tour).toEqual(workspace.rules.tour);
    expect(merged.rules.payment_manager).toEqual(workspace.rules.payment_manager);
    expect(merged.quietHours).toEqual(workspace.quietHours);
  });

  it("a sibling kind keeps tracking a LATER workspace change — never frozen at the moment one kind was customized", () => {
    // The house customized only `inspection`.
    const partial = { inspection: { ...workspace.rules.inspection, timings: ["before:2880"] } };
    // The workspace's `inspection_manager` rule changes AFTER that house override was saved.
    const laterWorkspace = normalizeReminderSettings({
      ...workspace,
      rules: { ...workspace.rules, inspection_manager: { ...workspace.rules.inspection_manager, timings: ["after:60"] } },
    });
    const merged = mergeReminderSettingsOverride(laterWorkspace, partial);
    // The customized kind still reflects the house's own value...
    expect(merged.rules.inspection.timings).toEqual(["before:2880"]);
    // ...and the untouched kind reflects the NEW workspace value, not the one
    // in effect when the house override was first saved.
    expect(merged.rules.inspection_manager.timings).toEqual(["after:60"]);
  });

  it("a whole legacy blob (saved before per-kind overrides existed) resolves as a partial with every kind — no migration", () => {
    // Every kind is nested under its own `rules` key, the shape
    // `savePropertyOverride` used to write before this change.
    const legacyBlob = {
      rules: workspace.rules,
      quietHours: { enabled: false, startHour: 0, endHour: 0 },
      automationSendMode: workspace.automationSendMode,
    };
    const laterWorkspace = normalizeReminderSettings({
      ...workspace,
      rules: { ...workspace.rules, inspection_manager: { ...workspace.rules.inspection_manager, timings: ["after:60"] } },
    });
    const merged = mergeReminderSettingsOverride(laterWorkspace, legacyBlob);
    // Every kind came from the legacy blob (it had every kind already), so a
    // later workspace change to `inspection_manager` does NOT show through —
    // this is the exact "frozen" behavior the legacy shape already had,
    // preserved as-is.
    expect(merged.rules.inspection_manager.timings).toEqual(workspace.rules.inspection_manager.timings);
    // `quietHours` is a workspace-wide clock setting, never a per-house
    // override (no UI path ever sends a `propertyId` with a quiet-hours
    // edit) — a legacy blob's own copy of it is NOT read; the CURRENT
    // workspace value always wins, same as every other resolution.
    expect(merged.quietHours).toEqual(laterWorkspace.quietHours);
  });

  it("an empty override (every kind cleared) is treated as no override at all", () => {
    expect(mergeReminderSettingsOverride(workspace, {})).toEqual(workspace);
    expect(mergeReminderSettingsOverride(workspace, null)).toEqual(workspace);
  });
});

describe("loadReminderSettingsForProperty + clearPropertyOverride(kind) — clearing one kind leaves siblings", () => {
  it("clearing one customized kind reverts JUST that kind to the workspace value", async () => {
    const { savePropertyOverride, clearPropertyOverride } = await import("@/lib/settings/property-overrides.server");
    const db = makeDb({
      manager_automation_settings: [{ manager_user_id: MGR, row_data: { reminderRules: workspace } }],
      manager_property_records: [{ id: BALLARD, manager_user_id: MGR, row_data: {} }],
    });
    await savePropertyOverride(db, MGR, BALLARD, "reminderRules", {
      inspection: { ...workspace.rules.inspection, timings: ["before:2880"] },
      tour: { ...workspace.rules.tour, timings: ["before:120"] },
    });
    let settings = await loadReminderSettingsForProperty(db, MGR, BALLARD);
    expect(settings.rules.inspection.timings).toEqual(["before:2880"]);
    expect(settings.rules.tour.timings).toEqual(["before:120"]);

    await clearPropertyOverride(db, MGR, BALLARD, "reminderRules", "inspection");
    settings = await loadReminderSettingsForProperty(db, MGR, BALLARD);
    // Cleared kind is back to the workspace value...
    expect(settings.rules.inspection.timings).toEqual(workspace.rules.inspection.timings);
    // ...but the sibling kind's own override survives untouched.
    expect(settings.rules.tour.timings).toEqual(["before:120"]);
  });
});
