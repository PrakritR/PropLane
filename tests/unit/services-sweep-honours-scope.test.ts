import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sweepWorkOrderEscalations } from "@/lib/reminders/subjects/services.server";

/**
 * Minimal in-memory Supabase stub supporting the chains this sweep, the
 * settings resolver, and `materializeReminders` issue: `.select().eq().in()
 * .limit().order().not().maybeSingle()` for reads, `.upsert()` for the
 * reminder queue write. Rows are plain arrays per table; filters compose.
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

function makeDb(tables: Record<string, Row[]>, onUpsert?: (table: string, rows: Row[]) => void): SupabaseClient {
  return {
    from(table: string) {
      const rows = tables[table] ?? [];
      const filters: Array<(r: Row) => boolean> = [];
      let selectCols: string | undefined;
      const builder: Record<string, unknown> = {
        select(cols?: string) {
          selectCols = cols;
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
        not() {
          return builder;
        },
        order() {
          return builder;
        },
        limit() {
          return builder;
        },
        maybeSingle() {
          const match = rows.filter((r) => filters.every((f) => f(r)))[0] ?? null;
          return Promise.resolve({ data: match ? projectSelect(match, selectCols) : null, error: null });
        },
        upsert(nextRows: Row[]) {
          onUpsert?.(table, nextRows);
          return Promise.resolve({ error: null });
        },
        then(resolve: (v: { data: Row[]; error: null }) => unknown) {
          const matched = rows.filter((r) => filters.every((f) => f(r)));
          return resolve({ data: matched.map((r) => projectSelect(r, selectCols)), error: null });
        },
      };
      return builder as never;
    },
  } as unknown as SupabaseClient;
}

const MGR = "mgr-1";
const PROPERTY_A = "prop-a";
const PROPERTY_B = "prop-b";
const CREATED_AT = "2024-01-01T12:00:00.000Z";
const NOW = new Date("2024-01-01T12:30:00.000Z");

// Fixed reminders (S020, captain 2026-09-27): "reminders always consistent
// for everything… remove adjustable reminders." A stored quiet-hours
// override is exactly the kind of customization the engine now ignores — the
// built-in default (9 PM-8 AM Pacific, `DEFAULT_QUIET_HOURS`) always applies,
// so `CREATED_AT` (4 AM Pacific) + the built-in 1-day-after default lands at
// 4 AM Pacific the next day and gets pushed to 8 AM Pacific
// (`2024-01-02T16:00:00.000Z`) regardless of what any row below still says.
const QUIET_HOURS_OFF = { quietHours: { enabled: false, startHour: 0, endHour: 0 } };
const PUSHED_SEND_AT = "2024-01-02T16:00:00.000Z";

/** Property A's own STORED Services override: escalate after 2 hours. Never read now. */
const PROPERTY_A_OVERRIDE = {
  ...QUIET_HOURS_OFF,
  rules: { work_order_unassigned: { timings: ["after:120"] } },
};

/** The account's STORED settings: escalate after 1 day, quiet hours off. Never read now either. */
const ACCOUNT_SETTINGS = {
  ...QUIET_HOURS_OFF,
  rules: { work_order_unassigned: { timings: ["after:1440"] } },
};

function workOrderRow(id: string, propertyId: string) {
  return {
    id,
    manager_user_id: MGR,
    resident_email: "resident@example.com",
    created_at: CREATED_AT,
    row_data: {
      id,
      bucket: "open",
      title: "Leaky faucet",
      propertyName: propertyId,
      assignedPropertyId: propertyId,
    },
  };
}

describe("services sweep ignores stored property/workspace overrides — fixed reminders (S020, captain 2026-09-27)", () => {
  it("an unassigned request at property A does NOT get the house's stored 2-hour rule; both A and B queue at the built-in 1-day default, quiet hours applied", async () => {
    const upserts: Row[] = [];
    const db = makeDb(
      {
        portal_work_order_records: [workOrderRow("wo-a", PROPERTY_A), workOrderRow("wo-b", PROPERTY_B)],
        manager_automation_settings: [{ manager_user_id: MGR, row_data: { reminderRules: ACCOUNT_SETTINGS } }],
        manager_property_records: [
          // Property A has its own stored override; Property B has none. Neither
          // is read any more — the resolver always answers with the built-in
          // default now, regardless of what either row holds.
          { id: PROPERTY_A, manager_user_id: MGR, row_data: { operationsSettings: { reminderRules: PROPERTY_A_OVERRIDE } } },
          { id: PROPERTY_B, manager_user_id: MGR, row_data: {} },
        ],
        profiles: [{ id: MGR, email: "manager@example.com", full_name: "The Manager" }],
      },
      (table, rows) => {
        if (table === "portal_reminder_records") upserts.push(...rows);
      },
    );

    const queued = await sweepWorkOrderEscalations(db, NOW);
    expect(queued).toBe(2);

    const byWorkOrder = new Map(upserts.map((row) => [row.subject_id as string, row]));
    const a = byWorkOrder.get("wo-a")!;
    const b = byWorkOrder.get("wo-b")!;

    // Property A's stored 2-hour override (-120) is ignored — it gets the
    // same built-in 1-day-after default as B, with the built-in quiet hours
    // (never the stored `QUIET_HOURS_OFF`) pushing the send time to 8 AM Pacific.
    expect(a.lead_minutes).toBe(-1440);
    expect(a.send_at).toBe(PUSHED_SEND_AT);

    // Property B: same built-in default, same quiet-hours push. The stored
    // "account" row above (also 1-day, also quiet-hours-off) is never read either.
    expect(b.lead_minutes).toBe(-1440);
    expect(b.send_at).toBe(PUSHED_SEND_AT);
  });

  it("a request with no property also resolves to the built-in default, quiet hours applied — nothing stored changes it", async () => {
    const upserts: Row[] = [];
    const db = makeDb(
      {
        portal_work_order_records: [
          {
            ...workOrderRow("wo-none", ""),
            row_data: { id: "wo-none", bucket: "open", title: "No property on file" },
          },
        ],
        manager_automation_settings: [{ manager_user_id: MGR, row_data: { reminderRules: ACCOUNT_SETTINGS } }],
        manager_property_records: [],
        profiles: [{ id: MGR, email: "manager@example.com", full_name: "The Manager" }],
      },
      (table, rows) => {
        if (table === "portal_reminder_records") upserts.push(...rows);
      },
    );

    const queued = await sweepWorkOrderEscalations(db, NOW);
    expect(queued).toBe(1);
    expect(upserts[0]!.lead_minutes).toBe(-1440);
    expect(upserts[0]!.send_at).toBe(PUSHED_SEND_AT);
  });
});
