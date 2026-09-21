import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_REMINDER_SETTINGS, type ReminderSettings } from "@/lib/reminders/rules";
import { materializeReminders } from "@/lib/reminders/queue.server";
import { sweepVendorOfferExpiry } from "@/lib/reminders/subjects/services.server";

/**
 * Minimal in-memory Supabase stub, following `services-sweep-honours-scope.test.ts`,
 * extended with `.gte()` for the vendor-offer-expiry sweep's date-range query.
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
        gte(col: string, val: string) {
          const bound = Date.parse(val);
          filters.push((r) => {
            const ms = Date.parse(String(r[col] ?? ""));
            return Number.isFinite(ms) && ms >= bound;
          });
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
const VENDOR_USER_ID = "vendor-user-1";
const VENDOR_DIRECTORY_ID = "vendor-dir-1";

describe("vendor sends honour the vendor's OWN settings at send time (PLAN-0915 area 4)", () => {
  it("a reminder for a vendor recipient is pushed by THAT vendor's quiet hours, not the manager's workspace setting", async () => {
    // The manager's own workspace quiet hours are OFF — if the push still
    // happens, it can only be the recipient's own override doing it.
    const settings: ReminderSettings = {
      ...DEFAULT_REMINDER_SETTINGS,
      quietHours: { enabled: false, startHour: 0, endHour: 0 },
    };
    const upserts: Row[] = [];
    const db = makeDb({}, (table, rows) => {
      if (table === "portal_reminder_records") upserts.push(...rows);
    });

    const now = new Date("2024-02-01T00:00:00.000Z");
    // 4 hours before this anchor (10am Pacific) is 6am Pacific — squarely
    // inside a 9pm-8am quiet window, and the anchor itself is late enough
    // that pushing forward to 8am still lands before it.
    const anchorIso = "2024-02-03T18:00:00.000Z";

    await materializeReminders(
      db,
      {
        managerUserId: MGR,
        kind: "vendor_offer_expiry",
        subjectId: "offer-1",
        anchorIso,
        recipients: [
          {
            email: "vendor@example.com",
            role: "vendor",
            userId: VENDOR_USER_ID,
            quietHours: { enabled: true, startHour: 21, endHour: 8 },
          },
        ],
        payload: {},
      },
      settings,
      now,
    );

    expect(upserts).toHaveLength(1);
    // Not the naive "4 hours before" time (6am) — pushed forward to 8am the
    // vendor's own quiet window ends, still by the same channel (SMS/email
    // stay whatever the dispatcher resolves; only the TIME moves).
    expect(upserts[0].send_at).toBe("2024-02-03T16:00:00.000Z");
  });

  it("sweepVendorOfferExpiry resolves each vendor's own quiet hours, not the manager's", async () => {
    const upserts: Row[] = [];
    const db = makeDb(
      {
        work_order_vendor_offers: [
          {
            id: "offer-1",
            work_order_id: "wo-1",
            vendor_directory_id: VENDOR_DIRECTORY_ID,
            vendor_user_id: VENDOR_USER_ID,
            manager_user_id: MGR,
            status: "sent",
            expires_at: "2024-02-03T18:00:00.000Z",
          },
        ],
        portal_work_order_records: [{ id: "wo-1", row_data: { id: "wo-1", bucket: "open", title: "Leaky faucet", propertyName: "5257 Brooklyn" } }],
        manager_vendor_records: [{ id: VENDOR_DIRECTORY_ID, row_data: { name: "Juniper Services", email: "juniper@example.com" } }],
        // The manager's own workspace quiet hours are OFF.
        manager_automation_settings: [{ manager_user_id: MGR, row_data: { reminderRules: { quietHours: { enabled: false, startHour: 0, endHour: 0 } } } }],
        // The vendor's own Settings → Notifications quiet window: 9pm-8am.
        notification_preferences: [{ user_id: VENDOR_USER_ID, row_data: { vendor: { quietHours: { enabled: true, startHour: 21, endHour: 8 } } } }],
      },
      (table, rows) => {
        if (table === "portal_reminder_records") upserts.push(...rows);
      },
    );

    const now = new Date("2024-02-01T00:00:00.000Z");
    const queued = await sweepVendorOfferExpiry(db, now);
    expect(queued).toBe(1);
    expect(upserts).toHaveLength(1);
    expect(upserts[0].recipient_role).toBe("vendor");
    // 6am, 9pm-8am quiet hours -> goes at 8am, still by the vendor's own
    // resolved channel (dispatch.server.ts gates SMS/email at send time).
    expect(upserts[0].send_at).toBe("2024-02-03T16:00:00.000Z");
  });
});
