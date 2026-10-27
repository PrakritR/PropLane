import { readFileSync } from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import {
  CHANNEL_SYNC_CRON_MAX_DURATION_MS,
  SYNC_ALL_CONCURRENCY,
  SYNC_ALL_STOP_SCHEDULING_MS,
  syncAllChannelCalendarImports,
  syncChannelCalendarConnectionIds,
} from "@/lib/channel-calendar/sync.server";

function dbWith(rows: Array<{ id: string; import_url: string | null; last_synced_at?: string | null }>): SupabaseClient {
  return {
    from: () => ({ select: () => ({ not: async () => ({ data: rows, error: null }) }) }),
  } as unknown as SupabaseClient;
}

const feeds = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ id: `c${String(i).padStart(2, "0")}`, import_url: `https://example.test/${i}.ics`, last_synced_at: null }));

describe("syncAllChannelCalendarImports budget and concurrency", () => {
  it("fetches at most four feeds at once and syncs all 60 when the budget holds", async () => {
    let active = 0;
    let peak = 0;
    const result = await syncAllChannelCalendarImports(dbWith(feeds(60)), {
      syncOne: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
      },
    });
    expect(peak).toBe(SYNC_ALL_CONCURRENCY);
    expect(result).toEqual({ synced: 60, failed: 0, skipped: 0 });
  });

  it("stops scheduling new fetches with under 20s left and reports the skipped count", async () => {
    let clock = 0;
    const started: string[] = [];
    const result = await syncAllChannelCalendarImports(dbWith(feeds(60)), {
      now: () => clock,
      concurrency: 1,
      syncOne: async (_db, id) => {
        started.push(id);
        clock += 5_000;
      },
    });
    // A feed is still started with exactly 20s left (not "under"), so 100s / 5s + 1 = 21 run; 39 wait.
    expect(result.synced).toBe(21);
    expect(result.skipped).toBe(39);
    expect(result.synced + result.failed + result.skipped).toBe(60);
    expect(120_000 - clock).toBeLessThanOrEqual(SYNC_ALL_STOP_SCHEDULING_MS);
  });

  it("counts a failing feed without stopping the rest, and skips rows with no import url", async () => {
    const rows = [...feeds(5), { id: "blank", import_url: "  ", last_synced_at: null }];
    const result = await syncAllChannelCalendarImports(dbWith(rows), {
      syncOne: async (_db, id) => {
        if (id === "c01") throw new Error("boom");
      },
    });
    expect(result).toEqual({ synced: 4, failed: 1, skipped: 0 });
  });

  it("syncs the least recently synced feeds first so skipped ones lead the next run", async () => {
    const order: string[] = [];
    await syncAllChannelCalendarImports(
      dbWith([
        { id: "new", import_url: "https://x.test/a.ics", last_synced_at: "2026-10-26T10:00:00Z" },
        { id: "never", import_url: "https://x.test/b.ics", last_synced_at: null },
        { id: "old", import_url: "https://x.test/c.ics", last_synced_at: "2026-10-01T10:00:00Z" },
      ]),
      { concurrency: 1, syncOne: async (_db, id) => void order.push(id) },
    );
    expect(order).toEqual(["never", "old", "new"]);
  });

  it("keeps the budget in step with the cron route's maxDuration", () => {
    const route = readFileSync(path.join(process.cwd(), "src/app/api/cron/sync-channel-calendars/route.ts"), "utf8");
    expect(route).toContain(`maxDuration = ${CHANNEL_SYNC_CRON_MAX_DURATION_MS / 1000}`);
  });

  it("the portal's Sync all runs the same pool: four at a time, in order, and reports what it skipped", async () => {
    let active = 0;
    let peak = 0;
    const ids = feeds(10).map((f) => f.id);
    const result = await syncChannelCalendarConnectionIds({} as SupabaseClient, ids, {
      syncOne: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
      },
    });
    expect(peak).toBe(SYNC_ALL_CONCURRENCY);
    expect(result).toEqual({ synced: 10, failed: 0, skipped: 0 });

    let clock = 0;
    const budgeted = await syncChannelCalendarConnectionIds({} as SupabaseClient, feeds(60).map((f) => f.id), {
      now: () => clock,
      concurrency: 1,
      syncOne: async () => {
        clock += 5_000;
      },
    });
    expect(budgeted).toEqual({ synced: 21, failed: 0, skipped: 39 });
  });

  it("the portal route shares the helper instead of looping itself, and keeps its auth and scoping", () => {
    const route = readFileSync(path.join(process.cwd(), "src/app/api/portal/channel-calendar/sync-all/route.ts"), "utf8");
    expect(route).toContain("syncChannelCalendarConnectionIds");
    expect(route).not.toContain("syncChannelCalendarConnection(");
    expect(route).toContain("skipped");
    expect(route).toContain("requireManagerRouteUser");
    expect(route).toContain("managerCanWriteCalendarForProperty");
    expect(route).toContain(`maxDuration = ${CHANNEL_SYNC_CRON_MAX_DURATION_MS / 1000}`);
  });
});
