import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sweepTenancyReminders, tenancyAnchorIso } from "@/lib/reminders/subjects/tenancy.server";

/**
 * Minimal in-memory Supabase stub, following `services-sweep-honours-scope.test.ts`.
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
// Every pre-existing lease/move kind disabled so only the three new
// lease-ending-sequence kinds fire — keeps each assertion about exactly one
// moment, not a mixed bag of every reminder this manager might get.
const ACCOUNT_SETTINGS = {
  quietHours: { enabled: false, startHour: 0, endHour: 0 },
  rules: {
    lease_ending: { enabled: false },
    lease_ending_manager: { enabled: false },
    move_in: { enabled: false },
    move_out: { enabled: false },
    move_out_inspection_manager: { enabled: false },
    deposit_accounting: { enabled: false },
  },
};

function applicationRow(id: string, rowData: Row) {
  return {
    id,
    manager_user_id: MGR,
    resident_email: "resident@example.com",
    row_data: { bucket: "approved", name: "Jamie Resident", property: "5257 Brooklyn", ...rowData },
  };
}

describe("lease-ending sequence (PLAN-0915 area 4)", () => {
  it("queues a renewal offer 60 days before the lease ends, informational only", async () => {
    const upserts: Row[] = [];
    const db = makeDb(
      {
        manager_application_records: [applicationRow("app-renewal", { application: { leaseStart: "2024-01-01", leaseEnd: "2024-06-01" } })],
        manager_automation_settings: [{ manager_user_id: MGR, row_data: { reminderRules: ACCOUNT_SETTINGS } }],
        profiles: [{ id: MGR, email: "manager@example.com", full_name: "The Manager" }],
      },
      (table, rows) => {
        if (table === "portal_reminder_records") upserts.push(...rows);
      },
    );

    const now = new Date("2024-01-01T00:00:00.000Z");
    const queued = await sweepTenancyReminders(db, now);
    expect(queued).toBeGreaterThan(0);

    const renewal = upserts.find((row) => row.kind === "lease_renewal_offer");
    expect(renewal).toBeDefined();
    expect(renewal!.recipient_role).toBe("counterparty");
    expect(renewal!.recipient_email).toBe("resident@example.com");
    const anchorIso = tenancyAnchorIso(new Date(2024, 5, 1)); // 9am Pacific, Jun 1 2024
    expect(renewal!.send_at).toBe(new Date(Date.parse(anchorIso) - 86400 * 60_000).toISOString());

    // Never a regulated notice: no statute citation, no accounting figure.
    const payload = renewal!.payload as Record<string, unknown>;
    expect(JSON.stringify(payload).toLowerCase()).not.toContain("deposit");
  });

  it("queues move-out instructions 14 days before, and a deposit return notice the day of", async () => {
    const upserts: Row[] = [];
    const db = makeDb(
      {
        manager_application_records: [
          applicationRow("app-moveout", { manualResidentDetails: { moveOutDate: "2024-02-01" } }),
        ],
        manager_automation_settings: [{ manager_user_id: MGR, row_data: { reminderRules: ACCOUNT_SETTINGS } }],
        profiles: [{ id: MGR, email: "manager@example.com", full_name: "The Manager" }],
      },
      (table, rows) => {
        if (table === "portal_reminder_records") upserts.push(...rows);
      },
    );

    const now = new Date("2024-01-01T00:00:00.000Z");
    await sweepTenancyReminders(db, now);

    const anchorIso = tenancyAnchorIso(new Date(2024, 1, 1)); // 9am Pacific, Feb 1 2024
    const anchorMs = Date.parse(anchorIso);

    const instructions = upserts.find((row) => row.kind === "move_out_instructions");
    expect(instructions).toBeDefined();
    expect(instructions!.recipient_role).toBe("counterparty");
    expect(instructions!.send_at).toBe(new Date(anchorMs - 20160 * 60_000).toISOString()); // 14 days before

    const depositNotice = upserts.find((row) => row.kind === "deposit_return_notice");
    expect(depositNotice).toBeDefined();
    expect(depositNotice!.recipient_role).toBe("counterparty");
    // "Day of move-out" — the smallest valid lead (5 minutes before the 9am anchor).
    expect(depositNotice!.send_at).toBe(new Date(anchorMs - 5 * 60_000).toISOString());
  });
});
