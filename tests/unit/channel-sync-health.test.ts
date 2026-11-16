import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildAttentionItems,
  buildSyncRows,
  SYNC_NOTICE_AFTER_MS,
  type HealthConnection,
} from "@/lib/channel-calendar/channel-health";
import { syncRowFact } from "@/components/portal/channels-health-card";
import { formatSyncFailureNotice } from "@/lib/manager-notice-format";
import type { ChannelStayTombstone } from "@/lib/channel-calendar/stay-tombstones";

const NOW = new Date("2026-11-16T02:30:00.000Z"); // Nov 15, 6:30 PM Pacific
const TODAY = "2026-11-15";

function conn(over: Partial<HealthConnection> = {}): HealthConnection {
  return {
    id: "c8",
    propertyId: "p",
    roomId: "room-8",
    roomLabel: "Room 8",
    houseLabel: "4709A 8th Ave",
    provider: "booking_com",
    label: null,
    lastSyncedAt: "2026-11-16T02:15:00.000Z",
    lastError: null,
    exportLastFetchedAt: null,
    hasImportUrl: true,
    ranges: [],
    ...over,
  };
}

const removedStay: ChannelStayTombstone = {
  propertyId: "p",
  roomId: "room-8",
  provider: "booking_com",
  sourceUid: "u1",
  range: { id: "u1", sourceUid: "u1", summary: "CLOSED - Not available", start: "2026-11-14", end: "2026-11-14" },
  removedAt: "2026-11-15T07:22:57.929Z",
};

describe("buildSyncRows", () => {
  it("counts reservations in the window (not host blocks, not stays long past or far ahead)", () => {
    const [row] = buildSyncRows({
      now: NOW,
      today: TODAY,
      connections: [
        conn({
          ranges: [
            { start: "2026-11-14", end: "2026-11-14", summary: "CLOSED - Not available" },
            { start: "2026-12-01", end: "2026-12-04", summary: "Reserved" },
            { start: "2026-11-20", end: "2027-11-20", summary: "Airbnb (Not available)", hostBlock: true },
            { start: "2026-08-01", end: "2026-08-03", summary: "Reserved" },
            { start: "2027-06-01", end: "2027-06-03", summary: "Reserved" },
          ],
        }),
      ],
    });
    expect(row).toMatchObject({ state: "ok", staysInWindow: 2, hiddenRemoved: 0 });
  });

  it("skips an export-only connection and flags error, never-synced and stale ones", () => {
    const rows = buildSyncRows({
      now: NOW,
      today: TODAY,
      connections: [
        conn({ id: "export-only", hasImportUrl: false }),
        conn({ id: "err", lastError: "Booking.com calendar returned 404." }),
        conn({ id: "export-err", lastError: "Export feed failed: boom" }),
        conn({ id: "never", lastSyncedAt: null }),
        conn({ id: "stale", lastSyncedAt: "2026-11-15T20:00:00.000Z" }),
      ],
    });
    expect(rows.map((r) => [r.connectionId, r.state])).toEqual([
      ["err", "error"],
      ["export-err", "ok"],
      ["never", "never"],
      ["stale", "stale"],
    ]);
    expect(rows.find((r) => r.connectionId === "export-err")!.lastError).toBeNull();
  });

  it("warns when a removed reservation the channel still lists is held back (the Nov 14 Room 8 case)", () => {
    const sync = buildSyncRows({ now: NOW, today: TODAY, connections: [conn()], removed: [removedStay] });
    expect(sync[0]!.hiddenRemoved).toBe(1);
    const items = buildAttentionItems({ connections: [conn()], stays: [], now: NOW, today: TODAY, sync });
    expect(items.map((i) => i.kind)).toEqual(["removed_stay_hidden"]);
    expect(items[0]!.text).toContain("4709A 8th Ave · Booking.com · Room 8");
  });

  it("ignores another room's removal, a host block's, and one that ended long ago", () => {
    const other = { ...removedStay, roomId: "room-9" };
    const block = { ...removedStay, range: { ...removedStay.range, hostBlock: true } };
    const old = { ...removedStay, range: { ...removedStay.range, start: "2026-10-01", end: "2026-10-02" } };
    const sync = buildSyncRows({ now: NOW, today: TODAY, connections: [conn()], removed: [other, block, old] });
    expect(sync[0]!.hiddenRemoved).toBe(0);
  });

  it("turns an unsynced connection into one attention line and a readable fact", () => {
    const sync = buildSyncRows({ now: NOW, today: TODAY, connections: [conn({ lastSyncedAt: "2026-11-15T20:00:00.000Z" })] });
    const items = buildAttentionItems({ connections: [], stays: [], now: NOW, today: TODAY, sync });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "sync_stale", id: "sync_stale:c8" });
    expect(syncRowFact(sync[0]!, NOW)).toMatch(/^Synced .* · 0 stays$/);
  });
});

describe("formatSyncFailureNotice", () => {
  it("names channel, house, room, how long and the error, then the link", () => {
    const n = formatSyncFailureNotice({ channel: "Booking.com", house: "4709A 8th Ave", room: "Room 8", hoursSince: 7.4, error: "Booking.com calendar returned 404.", url: "https://x/y" });
    expect(n.subject).toBe("Booking.com calendar is not syncing");
    expect(n.sms).toBe("Booking.com · 4709A 8th Ave · Room 8 has not synced in 7 hours (Booking.com calendar returned 404.). New bookings on it may be missing from PropLane.\nhttps://x/y");
    expect(n.lines).toContain("Last synced: 7 hours ago");
  });
  it("says never when nothing was ever read", () => {
    expect(formatSyncFailureNotice({ channel: "Airbnb" }).sms).toContain("has not synced yet");
  });
});

const emit = vi.hoisted(() => vi.fn(async () => ({ eventId: "x", duplicate: false, delivered: 1, submitted: 0, deferred: 0, failed: 0 })));
vi.mock("@/lib/action-events.server", () => ({ emitActionEvent: emit }));
vi.mock("@/lib/channel-calendar/sync.server", () => ({
  loadPropertyRecord: async () => ({ property: { buildingName: "4709A 8th Ave", listingSubmission: { rooms: [{ id: "room-8", name: "Room 8" }] } } }),
}));

describe("notifyFailingChannelSyncs", () => {
  beforeEach(() => emit.mockClear());

  function dbWith(rows: unknown[]) {
    const calls: string[] = [];
    const query = {
      select: () => query,
      not: () => query,
      or: (filter: string) => {
        calls.push(filter);
        return Promise.resolve({ data: rows, error: null });
      },
      eq: () => query,
      maybeSingle: async () => ({ data: { email: "m@x.com", full_name: "Mo" } }),
    };
    return { db: { from: () => query } as never, calls };
  }

  it("emits one rich notice per failing connection with a per-connection per-day id", async () => {
    const { notifyFailingChannelSyncs, channelSyncFailedEventId } = await import("@/lib/channel-calendar/channel-sync-notice.server");
    const row = { id: "c8", manager_user_id: "u", property_id: "p", room_id: "room-8", provider: "booking_com", label: null, last_synced_at: "2026-11-15T10:00:00.000Z", last_error: "Booking.com calendar returned 404.", created_at: "2026-10-01T00:00:00Z" };
    const { db, calls } = dbWith([row]);
    const result = await notifyFailingChannelSyncs(db, NOW);
    expect(result).toEqual({ checked: 1, notified: 1 });
    expect(calls[0]).toContain(new Date(NOW.getTime() - SYNC_NOTICE_AFTER_MS).toISOString());
    const arg = (emit.mock.calls[0] as unknown[])[1] as { eventId: string; event: string; recipients: Array<{ rendered: { text: string } }> };
    expect(arg.eventId).toBe(channelSyncFailedEventId("c8", "2026-11-15"));
    expect(arg.event).toBe("channel_sync_failed");
    expect(arg.recipients[0]!.rendered.text).toContain("Booking.com · 4709A 8th Ave · Room 8 has not synced in 16 hours");
    // A second run the same day carries the same id, which the bus de-duplicates.
    await notifyFailingChannelSyncs(db, new Date(NOW.getTime() + 15 * 60_000));
    expect((emit.mock.calls[1] as unknown[])[1]).toMatchObject({ eventId: arg.eventId });
  });

  it("sends nothing when no connection is past the threshold", async () => {
    const { notifyFailingChannelSyncs } = await import("@/lib/channel-calendar/channel-sync-notice.server");
    const { db } = dbWith([]);
    expect(await notifyFailingChannelSyncs(db, NOW)).toEqual({ checked: 0, notified: 0 });
    expect(emit).not.toHaveBeenCalled();
  });
});
