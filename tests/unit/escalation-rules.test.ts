import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sweepWorkOrderEscalations } from "@/lib/reminders/subjects/services.server";

/**
 * Minimal in-memory Supabase stub, following `services-sweep-honours-scope.test.ts`:
 * `.select().eq().in().limit().order().not().maybeSingle()` for reads,
 * `.upsert()` for the reminder queue write.
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
const CREATED_AT = "2024-01-01T12:00:00.000Z";
// Before both the 1-hour (emergency) and 1-day (normal) computed send times —
// reminders only queue future sends, and reminderSendTimes drops anything
// already past `now`.
const NOW = new Date("2024-01-01T12:30:00.000Z");

const QUIET_HOURS_OFF = { quietHours: { enabled: false, startHour: 0, endHour: 0 } };
const ACCOUNT_SETTINGS = { ...QUIET_HOURS_OFF };

function workOrderRow(id: string, opts: { emergency?: boolean } = {}) {
  return {
    id,
    manager_user_id: MGR,
    resident_email: "resident@example.com",
    created_at: CREATED_AT,
    row_data: {
      id,
      bucket: "open",
      title: opts.emergency ? "Gas smell" : "Leaky faucet",
      priority: opts.emergency ? "Emergency" : "Normal",
      propertyName: "5257 Brooklyn",
    },
  };
}

describe("services escalations (PLAN-0915 area 4)", () => {
  it("an unassigned request escalates at 1 day; an emergency one escalates at 1 hour", async () => {
    const upserts: Row[] = [];
    const db = makeDb(
      {
        portal_work_order_records: [workOrderRow("wo-normal"), workOrderRow("wo-emergency", { emergency: true })],
        manager_automation_settings: [{ manager_user_id: MGR, row_data: { reminderRules: ACCOUNT_SETTINGS } }],
        manager_property_records: [],
        profiles: [{ id: MGR, email: "manager@example.com", full_name: "The Manager" }],
      },
      (table, rows) => {
        if (table === "portal_reminder_records") upserts.push(...rows);
      },
    );

    const queued = await sweepWorkOrderEscalations(db, NOW);
    expect(queued).toBeGreaterThan(0);

    const byWorkOrder = new Map<string, Row[]>();
    for (const row of upserts) {
      const list = byWorkOrder.get(row.subject_id as string) ?? [];
      list.push(row);
      byWorkOrder.set(row.subject_id as string, list);
    }

    // Normal: escalates 1 day (1440 min) after filed, to the manager only.
    const normal = byWorkOrder.get("wo-normal")!;
    expect(normal).toHaveLength(1);
    expect(normal[0].kind).toBe("work_order_unassigned");
    expect(normal[0].lead_minutes).toBe(-1440);
    expect(normal[0].recipient_role).toBe("manager");
    expect(normal[0].send_at).toBe(new Date(Date.parse(CREATED_AT) + 1440 * 60_000).toISOString());

    // Emergency: escalates 1 hour (60 min) after filed, to the manager.
    // "You + co-managers" is an available audience choice in Settings, never
    // a default (tests/unit/reminder-team-scope.test.ts).
    const emergency = byWorkOrder.get("wo-emergency")!;
    expect(emergency).toHaveLength(1);
    expect(emergency[0].kind).toBe("work_order_unassigned_emergency");
    expect(emergency[0].lead_minutes).toBe(-60);
    expect(emergency[0].send_at).toBe(new Date(Date.parse(CREATED_AT) + 60 * 60_000).toISOString());
  });
});

describe("vendor silent after accept (PLAN-0915 area 4)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("re-offers to the next vendor when the accepted one has not scheduled within the configured window", async () => {
    vi.doMock("@/lib/work-order-offers.server", () => ({
      reofferWorkOrderToNextVendor: vi.fn().mockResolvedValue({ ok: true, vendorId: "vendor-2" }),
    }));
    vi.doMock("@/lib/work-order-events.server", () => ({
      workOrderEvent: vi.fn().mockResolvedValue(undefined),
    }));
    const { sweepVendorSilentAfterAccept: sweep } = await import("@/lib/reminders/subjects/services.server");
    const { reofferWorkOrderToNextVendor } = await import("@/lib/work-order-offers.server");

    const assignedAt = "2024-01-01T10:00:00.000Z";
    const now = new Date(Date.parse(assignedAt) + 25 * 60 * 60_000); // 25 hours later

    const updates: Row[] = [];
    const db = makeDbWithUpdate(
      {
        portal_work_order_records: [
          {
            id: "wo-silent",
            manager_user_id: MGR,
            row_data: { id: "wo-silent", bucket: "open", title: "Leaky faucet", vendorId: "vendor-1", vendorName: "Old Vendor", vendorAssignedAt: assignedAt },
          },
        ],
        manager_automation_settings: [{ manager_user_id: MGR, row_data: { serviceAutomation: { reofferAfterVendorSilentHours: 24 } } }],
        profiles: [{ id: MGR, email: "manager@example.com", full_name: "The Manager" }],
      },
      updates,
    );

    const acted = await sweep(db, now);
    expect(acted).toBe(1);
    expect(reofferWorkOrderToNextVendor).toHaveBeenCalledTimes(1);
    expect(reofferWorkOrderToNextVendor).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ workOrderId: "wo-silent", managerUserId: MGR }),
    );
    // No candidate was found in THIS test's stub — the re-offer itself is
    // mocked to succeed, so the job is never stamped as a dead end.
    expect(updates.find((u) => u.table === "portal_work_order_records")).toBeUndefined();
  });

  it("stamps the job and stops re-checking it once there is nobody left to re-offer to", async () => {
    vi.doMock("@/lib/work-order-offers.server", () => ({
      reofferWorkOrderToNextVendor: vi.fn().mockResolvedValue({ ok: false, reason: "no_candidate" }),
    }));
    vi.doMock("@/lib/work-order-events.server", () => ({
      workOrderEvent: vi.fn().mockResolvedValue(undefined),
    }));
    const { sweepVendorSilentAfterAccept: sweep } = await import("@/lib/reminders/subjects/services.server");

    const assignedAt = "2024-01-01T10:00:00.000Z";
    const now = new Date(Date.parse(assignedAt) + 25 * 60 * 60_000);

    const updates: Row[] = [];
    const baseRow = { id: "wo-dead-end", bucket: "open", title: "Leaky faucet", vendorId: "vendor-1", vendorName: "Old Vendor", vendorAssignedAt: assignedAt };
    const tables: Record<string, Row[]> = {
      portal_work_order_records: [{ id: "wo-dead-end", manager_user_id: MGR, row_data: { ...baseRow } }],
      manager_automation_settings: [{ manager_user_id: MGR, row_data: { serviceAutomation: { reofferAfterVendorSilentHours: 24 } } }],
      profiles: [{ id: MGR, email: "manager@example.com", full_name: "The Manager" }],
    };
    const db = makeDbWithUpdate(tables, updates, /* mutate */ true);

    const firstPass = await sweep(db, now);
    expect(firstPass).toBe(1);
    const stampUpdate = updates.find((u) => u.table === "portal_work_order_records");
    expect(stampUpdate).toBeDefined();
    expect((stampUpdate!.row_data as Row).vendorSilentEscalatedAt).toBeTruthy();

    // A second tick sees the stamp already on the row and does nothing.
    const secondPass = await sweep(db, new Date(now.getTime() + 5 * 60_000));
    expect(secondPass).toBe(0);
  });
});

/** Extends `makeDb` with a mutating `.update()`, needed to prove the dedupe stamp sticks across ticks. */
function makeDbWithUpdate(tables: Record<string, Row[]>, updates: (Row & { table: string })[], mutate = false): SupabaseClient {
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
        update(patch: Row) {
          return {
            eq(col: string, val: unknown) {
              const matched = rows.filter((r) => String(r[col]) === String(val) && filters.every((f) => f(r)));
              updates.push({ table, ...patch });
              if (mutate) {
                for (const row of matched) Object.assign(row, patch);
              }
              return Promise.resolve({ error: null });
            },
          };
        },
        then(resolve: (v: { data: Row[]; error: null }) => unknown) {
          return resolve({ data: rows.filter((r) => filters.every((f) => f(r))), error: null });
        },
      };
      return builder as never;
    },
  } as unknown as SupabaseClient;
}
