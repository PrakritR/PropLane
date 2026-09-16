/**
 * `suggestManagerTimeForKind` is the server-side wiring around the pure
 * `suggestManagerTime` engine (`manager-schedule-suggest.test.ts` covers that
 * math directly): it has to load a manager's painted services/tasks
 * availability and every busy window — scheduled work orders, tasks, tours,
 * and Google Calendar — before handing off to the engine. This test stubs
 * Supabase the way the other `*.server` tests do (`db.from().select().eq()…`,
 * see `tests/unit/public-tour-availability-subtraction.test.ts`) and mocks the
 * Google reader out entirely, since a services/tasks suggestion never needs a
 * real calendar link to be exercised.
 */
import { describe, expect, it, vi } from "vitest";
import { managerKindAvailabilityStorageKey } from "@/lib/manager-availability-kinds";
import { managerTasksStorageKey } from "@/lib/manager-tasks";
import { TOUR_CALENDAR_TIME_ZONE, zonedWallTimeMs } from "@/lib/tour-slot-math";

vi.mock("@/lib/tour-availability.server", () => ({
  googleBusyBlocks: vi.fn(async () => []),
}));

import { suggestManagerTimeForKind } from "@/lib/manager-schedule-suggest.server";

const MANAGER = "mgr-suggest-1";
// Mon Sep 14 2026, 10:00 Pacific (PDT, UTC-7) — Tuesday the 15th is "tomorrow".
const NOW = new Date("2026-09-14T17:00:00Z");
const TOMORROW = "2026-09-15";

function pacificIso(dateStr: string, minute: number): string {
  const [year, month, day] = dateStr.split("-").map(Number);
  return new Date(zonedWallTimeMs(year!, month!, day!, minute, TOUR_CALENDAR_TIME_ZONE)).toISOString();
}

type Row = Record<string, unknown>;

/** A minimal thenable query builder: every `.eq()`/`.neq()` narrows the row
 * set and returns another builder, and awaiting the chain at any point (or
 * calling `.maybeSingle()`) resolves it — matching how the real Postgrest
 * builder can be awaited without a named terminal call. */
function makeQuery(rows: Row[]) {
  const query: PromiseLike<{ data: Row[]; error: null }> & Record<string, unknown> = {
    eq: (column: string, value: unknown) => makeQuery(rows.filter((row) => row[column] === value)),
    neq: (column: string, value: unknown) => makeQuery(rows.filter((row) => row[column] !== value)),
    select: () => query,
    maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
    then: (resolve: (value: { data: Row[]; error: null }) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve({ data: rows, error: null }).then(resolve, reject),
  };
  return query;
}

function makeDb(tables: Record<string, Row[]>) {
  return {
    from: (table: string) => makeQuery(tables[table] ?? []),
  };
}

describe("suggestManagerTimeForKind", () => {
  it("prefers a painted services window, minus a booked work order, over a PropLane pick", async () => {
    const db = makeDb({
      portal_schedule_records: [
        {
          id: managerKindAvailabilityStorageKey(MANAGER, "services"),
          row_data: { payload: [`${TOMORROW}:18`, `${TOMORROW}:19`, `${TOMORROW}:20`, `${TOMORROW}:21`] }, // 9:00-11:00
        },
        { id: managerTasksStorageKey(MANAGER), row_data: { tasks: [] } },
        { id: "axis_admin_planned_events_v1", row_data: { payload: [] } },
      ],
      portal_work_order_records: [
        {
          id: "wo-1",
          manager_user_id: MANAGER,
          row_data: { scheduledAtIso: pacificIso(TOMORROW, 9 * 60), bucket: "scheduled", durationMinutes: 60 },
        },
      ],
    });

    const result = await suggestManagerTimeForKind(db as never, MANAGER, {
      kind: "services",
      seed: "wo-1",
      now: NOW,
    });

    expect(result?.source).toBe("availability");
    expect(result?.iso).toBe(pacificIso(TOMORROW, 10 * 60));
  });

  it("falls back to a PropLane pick when the manager has painted no availability", async () => {
    const db = makeDb({
      portal_schedule_records: [
        { id: managerTasksStorageKey(MANAGER), row_data: { tasks: [] } },
        { id: "axis_admin_planned_events_v1", row_data: { payload: [] } },
      ],
      portal_work_order_records: [],
    });

    const result = await suggestManagerTimeForKind(db as never, MANAGER, {
      kind: "services",
      seed: "wo-2",
      now: NOW,
    });

    expect(result?.source).toBe("proplane-pick");
  });
});
