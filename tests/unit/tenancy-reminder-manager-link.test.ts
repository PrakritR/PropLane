import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sweepTenancyReminders } from "@/lib/reminders/subjects/tenancy.server";

/** In-memory Supabase stub, same shape as `lease-ending-sequence.test.ts`. */
type Row = Record<string, unknown>;

function makeDb(tables: Record<string, Row[]>, onUpsert: (table: string, rows: Row[]) => void): SupabaseClient {
  return {
    from(table: string) {
      const rows = tables[table] ?? [];
      const filters: Array<(r: Row) => boolean> = [];
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq(col: string, val: unknown) {
          filters.push((r) => String(r[col]) === String(val));
          return builder;
        },
        in(col: string, vals: unknown[]) {
          const set = new Set(vals.map(String));
          filters.push((r) => set.has(String(r[col])));
          return builder;
        },
        not: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: () => Promise.resolve({ data: rows.filter((r) => filters.every((f) => f(r)))[0] ?? null, error: null }),
        upsert(nextRows: Row[]) {
          onUpsert(table, nextRows);
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
const OFF = { enabled: false };
const SETTINGS = {
  quietHours: { enabled: false, startHour: 0, endHour: 0 },
  rules: {
    lease_ending: OFF,
    lease_ending_manager: OFF,
    move_out: OFF,
    move_out_inspection_manager: OFF,
    deposit_accounting: OFF,
    lease_renewal_offer: OFF,
    move_out_instructions: OFF,
    deposit_return_notice: OFF,
    move_in: {
      enabled: true,
      leadMinutes: [1440],
      audience: { manager: true, counterparty: true, team: false, vendor: false },
      teamUserIds: [],
    },
  },
};

describe("move-in reminder links", () => {
  it("sends the resident the resident portal and the manager the resident's manager-portal record", async () => {
    const upserts: Row[] = [];
    const db = makeDb(
      {
        manager_application_records: [
          {
            id: "app-movein",
            manager_user_id: MGR,
            resident_email: "resident@example.com",
            row_data: { bucket: "approved", name: "Jamie Resident", property: "5257 Brooklyn", manualResidentDetails: { moveInDate: "2024-03-01" } },
          },
        ],
        manager_automation_settings: [{ manager_user_id: MGR, row_data: { reminderRules: SETTINGS } }],
        profiles: [{ id: MGR, email: "manager@example.com", full_name: "The Manager" }],
      },
      (table, rows) => {
        if (table === "portal_reminder_records") upserts.push(...rows);
      },
    );

    await sweepTenancyReminders(db, new Date("2024-01-01T00:00:00.000Z"));

    const moveIn = upserts.filter((row) => row.kind === "move_in");
    const resident = moveIn.find((row) => row.recipient_role === "counterparty");
    const manager = moveIn.find((row) => row.recipient_role === "manager");
    expect(resident).toBeDefined();
    expect(manager).toBeDefined();
    expect(String((resident!.payload as Row).url)).toMatch(/\/resident\/my-home$/);
    const managerUrl = String((manager!.payload as Row).url);
    expect(managerUrl).not.toContain("/resident/");
    expect(managerUrl).toMatch(/\/portal\/residents\/current\/app-movein$/);
  });
});
