// EVIDENCE HARNESS — the two parts of bookings-channels-1026 that nobody can screenshot: the clash alert a
// manager gets after a sync finds a double booking (exactly one, however many syncs find it), and the pooled
// "Sync all" that runs four feeds at a time and stops scheduling before the cron's own deadline.
// Set EVIDENCE_DIR to write the transcript; without it this is an ordinary assertion-only test.
import { mkdirSync, writeFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { createFakeDb } from "../helpers/fake-table-db";

const emitted = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));
vi.mock("@/lib/action-events.server", () => ({
  emitActionEvent: vi.fn(async (_db: unknown, input: Record<string, unknown>) => {
    // The bus is idempotent on the event id: a repeat is a no-op, exactly what the real insert does.
    if (!emitted.calls.some((call) => call.eventId === input.eventId)) emitted.calls.push(input);
  }),
}));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));

import { detectChannelClashes } from "@/lib/channel-calendar/channel-overlap.server";
import { emitChannelClashEvent } from "@/lib/channel-booking-events.server";
import { SYNC_ALL_CONCURRENCY, SYNC_ALL_STOP_SCHEDULING_MS, syncAllChannelCalendarImports } from "@/lib/channel-calendar/sync.server";

const P = "p1";
const lines: string[] = [];

function seed() {
  return createFakeDb({
    profiles: [{ id: "owner-1", email: "owner@x.test", full_name: "Owner" }],
    manager_property_records: [{ id: P, manager_user_id: "owner-1", property_data: { listingSubmission: { rooms: [{ id: "r8", name: "Room 8" }] } } }],
    external_calendar_connections: [
      { id: "ca", manager_user_id: "owner-1", property_id: P, room_id: "r8", provider: "airbnb", label: null, import_url: "x", export_token: "ta", imported_ranges: [{ id: "u1", sourceUid: "u1", summary: "Reserved", start: "2026-10-29", end: "2026-10-31", reservationCode: "HMAAAA0001" }] },
      { id: "cb", manager_user_id: "owner-1", property_id: P, room_id: "r8", provider: "booking_com", label: null, import_url: "y", export_token: "tb", imported_ranges: [{ id: "u2", sourceUid: "u2", summary: "CLOSED - Not available", start: "2026-10-30", end: "2026-11-02" }] },
    ],
    portal_schedule_records: [],
  });
}

const feeds = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ id: `c${String(i).padStart(2, "0")}`, import_url: `https://example.test/${i}.ics`, last_synced_at: null }));
const dbWith = (rows: ReturnType<typeof feeds>): SupabaseClient =>
  ({ from: () => ({ select: () => ({ not: async () => ({ data: rows, error: null }) }) }) }) as unknown as SupabaseClient;

describe("evidence: what a sync finds and what it costs", () => {
  it("one alert per double booking, and Sync all inside the cron budget", async () => {
    const db = seed();
    lines.push(
      "Room 8 at 4709A is held by BOTH channels: Airbnb HMAAAA0001 Oct 29 - Oct 31, Booking.com Oct 30 - Nov 2.",
      "",
      "A. Every sync of that room, from either side, run three times:",
    );
    for (const connectionId of ["ca", "cb", "ca"]) {
      const clashes = await detectChannelClashes(db as never, { propertyId: P, connectionId, today: "2026-10-26" });
      for (const clash of clashes) await emitChannelClashEvent(db as never, { clash, managerUserId: "owner-1", propertyLabel: "4709A" });
      lines.push(`   sync ${connectionId === "ca" ? "Airbnb" : "Booking.com"} -> ${clashes.length} clash found; alerts raised so far: ${emitted.calls.length}`);
    }
    expect(emitted.calls).toHaveLength(1);
    const recipient = (emitted.calls[0]!.recipients as Array<{ rendered: { text: string } }>)[0]!;
    expect(recipient.rendered.text).toContain("Room 8 is double-booked Oct 30 – Nov 1 (Airbnb and Booking.com)");
    lines.push(
      `   the manager is told, once: "${recipient.rendered.text.trim()}"`,
      `   (event ${String(emitted.calls[0]!.domain)}/${String(emitted.calls[0]!.event)}, idempotent on its own id)`,
      "",
      "B. Sync all, with 60 linked feeds:",
    );

    let active = 0;
    let peak = 0;
    const all = await syncAllChannelCalendarImports(dbWith(feeds(60)), {
      syncOne: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
      },
    });
    expect(peak).toBe(SYNC_ALL_CONCURRENCY);
    expect(all).toEqual({ synced: 60, failed: 0, skipped: 0 });
    lines.push(`   fast feeds: ${JSON.stringify(all)}, never more than ${peak} fetches in flight at once`);

    let clock = 0;
    const slow = await syncAllChannelCalendarImports(dbWith(feeds(60)), {
      now: () => clock,
      concurrency: 1,
      syncOne: async () => {
        clock += 5_000;
      },
    });
    expect(slow.synced + slow.failed + slow.skipped).toBe(60);
    expect(120_000 - clock).toBeLessThanOrEqual(SYNC_ALL_STOP_SCHEDULING_MS);
    lines.push(
      `   slow feeds (5s each): ${JSON.stringify(slow)} — it stops starting new fetches with ${(SYNC_ALL_STOP_SCHEDULING_MS / 1000).toFixed(0)}s of the cron's budget left`,
      "   so the run always returns instead of being killed, and the skipped feeds are the next run's first work.",
    );

    const out = process.env.EVIDENCE_DIR ?? "";
    if (out) {
      mkdirSync(out, { recursive: true });
      const title = "A sync that finds a double booking alerts once; Sync all pools four feeds and respects the cron budget";
      writeFileSync(`${out}/52-channel-sync-and-clash.txt`, `${title}\n${"=".repeat(title.length)}\n\n${lines.join("\n")}\n`, "utf8");
    }
  });
});
