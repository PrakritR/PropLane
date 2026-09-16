import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DEFAULT_REMINDER_SETTINGS,
  normalizeReminderSettings,
  type ReminderSettings,
} from "@/lib/reminders/rules";
import { loadReminderSettingsResolver } from "@/lib/reminders/settings.server";

/** Minimal in-memory Supabase supporting the resolver's `.select().in()` reads. */
type Row = Record<string, unknown>;
function makeDb(tables: Record<string, Row[]>): SupabaseClient {
  return {
    from(table: string) {
      const rows = tables[table] ?? [];
      const filters: Array<(r: Row) => boolean> = [];
      const builder: Record<string, unknown> = {
        select() {
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
          return Promise.resolve({ data: rows.filter((r) => filters.every((f) => f(r)))[0] ?? null, error: null });
        },
        then(resolve: (v: { data: Row[]; error: null }) => unknown) {
          return resolve({ data: rows.filter((r) => filters.every((f) => f(r))), error: null });
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
