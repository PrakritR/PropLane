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

function makeDb(tables: Record<string, Row[]>, onUpsert?: (table: string, rows: Row[]) => void): SupabaseClient {
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
          return Promise.resolve({ data: match, error: null });
        },
        upsert(nextRows: Row[]) {
          onUpsert?.(table, nextRows);
          return Promise.resolve({ error: null });
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
const PROPERTY_A = "prop-a";
const PROPERTY_B = "prop-b";
const CREATED_AT = "2024-01-01T12:00:00.000Z";
const NOW = new Date("2024-01-01T12:30:00.000Z");

// Quiet hours off so a computed send time is exactly anchor + timing, never
// pushed forward — the test only cares about which timing fired.
const QUIET_HOURS_OFF = { quietHours: { enabled: false, startHour: 0, endHour: 0 } };

/** Property A's own Services rule: escalate an unassigned request after 2 hours (120 min). */
const PROPERTY_A_OVERRIDE = {
  ...QUIET_HOURS_OFF,
  rules: { work_order_unassigned: { timings: ["after:120"] } },
};

/** The account default: escalate after 1 day (1440 min) — property B never overrides it. */
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

describe("services sweep honours the property/workspace scope", () => {
  it("an unassigned request at property A queues at the house's 2-hour rule, one at B keeps the account's 1-day rule", async () => {
    const upserts: Row[] = [];
    const db = makeDb(
      {
        portal_work_order_records: [workOrderRow("wo-a", PROPERTY_A), workOrderRow("wo-b", PROPERTY_B)],
        manager_automation_settings: [{ manager_user_id: MGR, row_data: { reminderRules: ACCOUNT_SETTINGS } }],
        manager_property_records: [
          // Property A is customized; Property B is not and has no workspace either.
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

    // Property A: 2 hours after creation (lead_minutes is negative for "after").
    expect(a.lead_minutes).toBe(-120);
    expect(a.send_at).toBe(new Date(Date.parse(CREATED_AT) + 120 * 60_000).toISOString());

    // Property B: the account's untouched 1-day-after default.
    expect(b.lead_minutes).toBe(-1440);
    expect(b.send_at).toBe(new Date(Date.parse(CREATED_AT) + 1440 * 60_000).toISOString());
  });

  it("a request with no property resolves to the account value (today's behaviour)", async () => {
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
  });
});
