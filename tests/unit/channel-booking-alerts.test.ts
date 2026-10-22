import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const emitActionEvent = vi.fn<(db: unknown, input: unknown) => Promise<unknown>>(async () => ({ eventId: "e", duplicate: false, delivered: 1, submitted: 0, deferred: 0, failed: 0 }));
vi.mock("@/lib/action-events.server", () => ({ emitActionEvent: (db: unknown, input: unknown) => emitActionEvent(db, input) }));
const track = vi.fn();
vi.mock("@/lib/analytics/posthog", () => ({ track: (...args: unknown[]) => track(...args) }));
// The owner's email leg has its own test (owner-booking-email.test.ts); here it must not reach a real mailer.
vi.mock("@/lib/manager-notice-email.server", () => ({ sendManagerNoticeEmail: async () => ({ status: "sent" }) }));
vi.mock("@/lib/communication/manager-assistant-workspace.server", () => ({ resolveManagerAssistantWorkspace: async () => ({ workspaceId: "", isDefault: true }) }));
vi.mock("@/lib/channel-calendar/airbnb-residents.server", () => ({
  upsertAirbnbResidentsFromImportedRanges: async () => undefined,
  releaseAirbnbResidentsAbsentFromFeed: async () => undefined,
}));
vi.mock("@/lib/channel-calendar/stay-tombstones.server", () => ({ loadChannelStayTombstoneKeys: async () => new Set<string>() }));

import { diffChannelReservations, reservationIdentitiesElsewhere, withoutMovedReservations } from "@/lib/channel-calendar/channel-booking-diff";
import { channelBookingStay, emitChannelBookingEvent, renderChannelBookingEvent } from "@/lib/channel-booking-events.server";
import { syncChannelCalendarConnection } from "@/lib/channel-calendar/sync.server";
import type { ChannelCalendarImportedRange } from "@/lib/channel-calendar/types";

const range = (uid: string, start: string, end: string, summary = "Reserved"): ChannelCalendarImportedRange => ({ id: uid, sourceUid: uid, summary, start, end });
const TODAY = "2026-10-09";

describe("diffChannelReservations", () => {
  it("reports a new reservation and a vanished one", () => {
    const diff = diffChannelReservations({ previous: [range("a", "2026-10-20", "2026-10-22")], next: [range("b", "2026-10-12", "2026-10-14")], baseline: false, today: TODAY });
    expect(diff.created.map((r) => r.sourceUid)).toEqual(["b"]);
    expect(diff.cancelled.map((r) => r.sourceUid)).toEqual(["a"]);
  });
  it("is silent on a connection's first sync", () => {
    expect(diffChannelReservations({ previous: [], next: [range("b", "2026-10-12", "2026-10-14")], baseline: true, today: TODAY })).toEqual({ created: [], cancelled: [] });
  });
  it("never alerts for host blocks, including Airbnb's echo of a PropLane stay", () => {
    const echo = range("e", "2026-10-12", "2026-10-14", "Airbnb (Not available)");
    const flagged = { ...range("f", "2026-10-15", "2026-10-16"), hostBlock: true };
    const diff = diffChannelReservations({ previous: [echo], next: [flagged], baseline: false, today: TODAY });
    expect(diff).toEqual({ created: [], cancelled: [] });
  });
  it("does not call a finished stay that left the feed a cancellation", () => {
    const diff = diffChannelReservations({ previous: [range("old", "2026-09-01", "2026-09-05")], next: [], baseline: false, today: TODAY });
    expect(diff.cancelled).toEqual([]);
  });
  it("does not cancel every stay when the feed comes back carrying nothing at all", () => {
    const diff = diffChannelReservations({
      previous: [range("a", "2026-10-20", "2026-10-22"), range("b", "2026-11-01", "2026-11-04")],
      next: [],
      baseline: false,
      today: TODAY,
    });
    expect(diff).toEqual({ created: [], cancelled: [] });
  });
  it("still reports a cancellation when the feed kept its other events", () => {
    const diff = diffChannelReservations({
      previous: [range("a", "2026-10-20", "2026-10-22")],
      next: [range("hb", "2026-10-25", "2026-10-26", "Airbnb (Not available)")],
      baseline: false,
      today: TODAY,
    });
    expect(diff.cancelled.map((r) => r.sourceUid)).toEqual(["a"]);
  });
  it("keys a feed without UIDs on the stay itself", () => {
    const a = { ...range("", "2026-10-12", "2026-10-14"), sourceUid: "" };
    expect(diffChannelReservations({ previous: [a], next: [{ ...a }], baseline: false, today: TODAY })).toEqual({ created: [], cancelled: [] });
  });
});

describe("moved reservations (relinking a room's import URL)", () => {
  const code = (uid: string, reservationCode: string) => ({ ...range(uid, "2026-10-12", "2026-10-14"), reservationCode });
  it("drops a stay another room holds, by UID or by reservation code, from both created and cancelled", () => {
    const elsewhere = reservationIdentitiesElsewhere([[range("same-uid", "2026-10-12", "2026-10-14"), code("x", "HMCODE")]]);
    const diff = {
      created: [range("same-uid", "2026-10-12", "2026-10-14"), code("new-uid", "HMCODE"), range("really-new", "2026-10-13", "2026-10-15")],
      cancelled: [range("same-uid", "2026-10-12", "2026-10-14")],
    };
    const result = withoutMovedReservations(diff, elsewhere);
    expect(result.created.map((r) => r.sourceUid)).toEqual(["really-new"]);
    expect(result.cancelled).toEqual([]);
    expect(result.moved).toHaveLength(3);
  });
  it("never treats a host block elsewhere as the same booking, nor a UID-less stay as provably the same", () => {
    const hostBlock = { ...range("blk", "2026-10-12", "2026-10-14", "Airbnb (Not available)") };
    expect(reservationIdentitiesElsewhere([[hostBlock]]).size).toBe(0);
    const noUid = { ...range("", "2026-10-12", "2026-10-14"), sourceUid: "" };
    const elsewhere = reservationIdentitiesElsewhere([[noUid]]);
    expect(withoutMovedReservations({ created: [noUid], cancelled: [] }, elsewhere).created).toHaveLength(1);
  });
});

describe("channel booking event copy", () => {
  it("counts nights from the inclusive last night and shows the check-out day", () => {
    expect(channelBookingStay("2026-10-12", "2026-10-14")).toEqual({ label: "Oct 12 – Oct 15 (3 nights)", nights: 3 });
    expect(channelBookingStay("2026-10-12", "2026-10-12").label).toBe("Oct 12 – Oct 13 (1 night)");
  });
  it("renders the created and cancelled lines", () => {
    const facts = { provider: "airbnb" as const, propertyLabel: "5259 Brooklyn Ave", roomLabel: "Room 3", start: "2026-10-12", end: "2026-10-14" };
    expect(renderChannelBookingEvent("channel_booking_created", facts).text).toBe("New Airbnb booking · 5259 Brooklyn Ave · Room 3 · Oct 12 – Oct 15 (3 nights)");
    expect(renderChannelBookingEvent("channel_booking_cancelled", facts).text).toBe("Airbnb booking cancelled · 5259 Brooklyn Ave · Room 3 · Oct 12 – Oct 15 (3 nights)");
    expect(renderChannelBookingEvent("channel_booking_created", facts).smsText).toBe(renderChannelBookingEvent("channel_booking_created", facts).text);
  });
});

function profileDb() {
  return { from: () => ({ select() { return this; }, eq() { return this; }, maybeSingle: async () => ({ data: { email: "m@example.com", full_name: "Mgr" }, error: null }) }) } as unknown as SupabaseClient;
}

describe("emitChannelBookingEvent", () => {
  beforeEach(() => { emitActionEvent.mockClear(); track.mockClear(); });
  it("rides the manager audience, is keyed on connection + stay, and tracks the alert", async () => {
    const input = { event: "channel_booking_created" as const, connectionId: "c1", managerUserId: "m1", propertyId: "p1", roomId: "r1", provider: "airbnb" as const, propertyLabel: "5259 Brooklyn Ave", roomLabel: "Room 3", range: range("uid-1", "2026-10-12", "2026-10-14") };
    await emitChannelBookingEvent(profileDb(), input);
    await emitChannelBookingEvent(profileDb(), input);
    const [, first] = emitActionEvent.mock.calls[0]! as [unknown, { eventId: string; domain: string; event: string; senderUserId: string; managerUserId: string; payload: Record<string, unknown>; recipients: Array<{ audience: string; userId: string }> }];
    const [, second] = emitActionEvent.mock.calls[1]! as [unknown, { eventId: string }];
    expect(first.eventId).toBe(second.eventId);
    expect(first.eventId).toContain("c1:uid-1");
    expect(first).toMatchObject({ domain: "channel_booking", event: "channel_booking_created", senderUserId: "m1", managerUserId: "m1" });
    expect(first.recipients).toEqual([expect.objectContaining({ audience: "manager", userId: "m1" })]);
    expect(first.payload).toMatchObject({ connectionId: "c1", propertyId: "p1", roomId: "r1", provider: "airbnb", start: "2026-10-12", end: "2026-10-14", nights: 3, guestLabel: "Booked (Airbnb)" });
    expect(track).toHaveBeenCalledWith("channel_booking_alert", "m1", { provider: "airbnb", kind: "created" });
  });
  it("tracks cancelled alerts as kind cancelled", async () => {
    await emitChannelBookingEvent(profileDb(), { event: "channel_booking_cancelled", connectionId: "c1", managerUserId: "m1", propertyId: "p1", roomId: "r1", provider: "airbnb", range: range("u", "2026-10-12", "2026-10-14") });
    expect(track).toHaveBeenCalledWith("channel_booking_alert", "m1", { provider: "airbnb", kind: "cancelled" });
  });
});

// ---- the whole sync: stored ranges in, feed in, events out ----
function ics(events: Array<{ uid: string; start: string; end: string; summary: string }>): string {
  const body = events.map((e) => `BEGIN:VEVENT\nUID:${e.uid}\nDTSTART;VALUE=DATE:${e.start.replace(/-/g, "")}\nDTEND;VALUE=DATE:${e.end.replace(/-/g, "")}\nSUMMARY:${e.summary}\nEND:VEVENT`).join("\n");
  return `BEGIN:VCALENDAR\nVERSION:2.0\n${body}\nEND:VCALENDAR`;
}

type Sibling = {
  id: string;
  imported_ranges: unknown[];
  property_id?: string;
  provider?: string;
  label?: string | null;
  import_url?: string | null;
  /** What that connection recorded as having LEFT its feed (`{ identity: iso }`). */
  released_identities?: Record<string, string>;
  last_synced_at?: string | null;
};

/** Which workspace each house belongs to: the move check only looks inside the connection's own workspace. */
const HOUSE_WORKSPACES = [
  { id: "p1", workspace_id: "ws-1" },
  { id: "p2", workspace_id: "ws-1" },
  { id: "p-elsewhere", workspace_id: "ws-2" },
];

function syncDb(connection: Record<string, unknown>, others: Sibling[] = []) {
  const stored = { ...connection };
  const siblings = others.map((row) => ({
    property_id: "p2",
    provider: "airbnb",
    label: null,
    import_url: null,
    released_identities: {},
    last_synced_at: null,
    ...row,
  }));
  const from = (table: string) => {
    let patch: Record<string, unknown> | null = null;
    let readingOthers = false;
    let readingHouses = false;
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      // The houses of this manager's connections, with their workspace (the move check's scope).
      in: () => { readingHouses = true; return chain; },
      // The workspace's OTHER channel connections (the move check).
      neq: () => { readingOthers = true; return chain; },
      update: (value: Record<string, unknown>) => { patch = value; if (table === "external_calendar_connections") Object.assign(stored, value); return chain; },
      maybeSingle: async () => table === "external_calendar_connections"
        ? { data: stored, error: null }
        : table === "profiles"
          ? { data: { email: "m@example.com", full_name: "Mgr" }, error: null }
          : { data: { manager_user_id: "m1", property_data: { id: "p1", title: "5259 Brooklyn Ave", buildingName: "5259 Brooklyn Ave", listingSubmission: { rooms: [{ id: "r1", name: "Room 3", manualUnavailableRanges: [] }] } }, row_data: {} }, error: null },
      single: async () => ({ data: stored, error: null }),
      then: (resolve: (value: unknown) => void) =>
        resolve({ error: null, data: readingOthers ? siblings : readingHouses ? HOUSE_WORKSPACES : patch }),
    };
    return chain;
  };
  return { db: { from } as unknown as SupabaseClient, stored };
}

const baseConnection = {
  id: "c1", manager_user_id: "m1", property_id: "p1", room_id: "r1", provider: "airbnb",
  label: null, import_url: "https://www.airbnb.com/calendar/ical/123.ics?s=abc", export_token: "tok", last_error: null,
};

function stubFeed(text: string) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(text, { status: 200, headers: { "content-type": "text/calendar" } })));
}

/** Per-feed responses, matched on a fragment of the import URL; anything else answers an empty calendar. */
function stubFeeds(byUrlFragment: Record<string, string>) {
  const spy = vi.fn(async (url: unknown) => {
    const hit = Object.keys(byUrlFragment).find((fragment) => String(url).includes(fragment));
    return new Response(hit ? byUrlFragment[hit]! : ics([]), { status: 200, headers: { "content-type": "text/calendar" } });
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

/** `count` sibling rooms of the same workspace and channel, most recently synced first. */
function manyRooms(count: number): Sibling[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `c-room-${i}`,
    property_id: "p2",
    imported_ranges: [],
    import_url: `https://www.airbnb.com/calendar/ical/room-${i}.ics?s=abc`,
    last_synced_at: `2026-10-09T1${9 - Math.min(9, i)}:00:00Z`,
  }));
}

describe("syncChannelCalendarConnection alerts", () => {
  beforeEach(() => { emitActionEvent.mockClear(); vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-09T12:00:00Z")); });
  const eventsOf = () => emitActionEvent.mock.calls.map((call) => (call[1] as { event: string }).event);

  it("stays silent on the first sync (baseline) even with reservations in the feed", async () => {
    stubFeed(ics([{ uid: "u1", start: "2026-10-12", end: "2026-10-15", summary: "Reserved" }]));
    const { db } = syncDb({ ...baseConnection, imported_ranges: [], last_synced_at: null });
    await syncChannelCalendarConnection(db, "c1");
    expect(emitActionEvent).not.toHaveBeenCalled();
  });

  it("emits created for a new reservation and cancelled for a vanished one, but not for host blocks", async () => {
    stubFeed(ics([
      { uid: "new", start: "2026-10-12", end: "2026-10-15", summary: "Reserved" },
      { uid: "blk", start: "2026-10-20", end: "2026-10-22", summary: "Airbnb (Not available)" },
    ]));
    const { db } = syncDb({ ...baseConnection, last_synced_at: "2026-10-09T11:45:00Z", imported_ranges: [{ id: "gone", sourceUid: "gone", summary: "Reserved", start: "2026-10-25", end: "2026-10-27" }] });
    await syncChannelCalendarConnection(db, "c1");
    expect(eventsOf().sort()).toEqual(["channel_booking_cancelled", "channel_booking_created"]);
    const created = emitActionEvent.mock.calls.map((c) => c[1] as { event: string; payload: Record<string, unknown>; recipients: Array<{ rendered: { text: string } }> }).find((c) => c.event === "channel_booking_created")!;
    expect(created.recipients[0]!.rendered.text).toContain("New Airbnb booking · 5259 Brooklyn Ave · Room 3 · Oct 12 – Oct 15 (3 nights)");
    expect(created.payload).toMatchObject({ connectionId: "c1", start: "2026-10-12" });
  });

  it("a re-run of the same sync does not notify again", async () => {
    stubFeed(ics([{ uid: "new", start: "2026-10-12", end: "2026-10-15", summary: "Reserved" }]));
    const { db } = syncDb({ ...baseConnection, last_synced_at: "2026-10-09T11:45:00Z", imported_ranges: [] });
    await syncChannelCalendarConnection(db, "c1");
    expect(eventsOf()).toEqual(["channel_booking_created"]);
    emitActionEvent.mockClear();
    await syncChannelCalendarConnection(db, "c1");
    expect(emitActionEvent).not.toHaveBeenCalled();
  });

  it("skips a connection whose manager does not own its property, and logs channel_sync_foreign_property", async () => {
    const fetched = vi.fn(async () => new Response(ics([]), { status: 200, headers: { "content-type": "text/calendar" } }));
    vi.stubGlobal("fetch", fetched);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { db, stored } = syncDb({ ...baseConnection, manager_user_id: "attacker", imported_ranges: [], last_synced_at: null });
      await expect(syncChannelCalendarConnection(db, "c1")).rejects.toThrow("channel_sync_foreign_property");
      expect(warn.mock.calls.map((c) => String(c[0])).join(" ")).toContain("channel_sync_foreign_property");
      // Nothing was fetched and nothing was written onto the (foreign) property or the connection row.
      expect(fetched).not.toHaveBeenCalled();
      expect(stored.last_synced_at).toBeNull();
      expect(emitActionEvent).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("a failing alert never fails the sync", async () => {
    emitActionEvent.mockRejectedValueOnce(new Error("bus down"));
    stubFeed(ics([{ uid: "new", start: "2026-10-12", end: "2026-10-15", summary: "Reserved" }]));
    const { db } = syncDb({ ...baseConnection, last_synced_at: "2026-10-09T11:45:00Z", imported_ranges: [] });
    await expect(syncChannelCalendarConnection(db, "c1")).resolves.toMatchObject({ id: "c1" });
  });

  describe("relinking a room moves its stays instead of cancelling and re-announcing them", () => {
    const moved = { id: "uid-moved", sourceUid: "uid-moved", summary: "Reserved", start: "2026-10-12", end: "2026-10-15", reservationCode: "HMMOVED123" };

    it("the room that TOOK the stays does not announce them as new when another room of the workspace still holds them", async () => {
      stubFeed(ics([{ uid: "uid-moved", start: "2026-10-12", end: "2026-10-15", summary: "Reserved" }]));
      const { db } = syncDb(
        { ...baseConnection, last_synced_at: "2026-10-09T11:45:00Z", imported_ranges: [] },
        [{ id: "c2", imported_ranges: [moved] }],
      );
      await syncChannelCalendarConnection(db, "c1");
      expect(emitActionEvent).not.toHaveBeenCalled();
    });

    it("the room that LOST the stays does not announce a cancellation when another room now holds them", async () => {
      stubFeed(ics([{ uid: "other", start: "2026-11-02", end: "2026-11-04", summary: "Reserved" }]));
      const { db } = syncDb(
        { ...baseConnection, last_synced_at: "2026-10-09T11:45:00Z", imported_ranges: [moved] },
        [{ id: "c2", imported_ranges: [moved] }],
      );
      await syncChannelCalendarConnection(db, "c1");
      // Only the genuinely new booking is news; the moved stay is neither new nor cancelled.
      expect(eventsOf()).toEqual(["channel_booking_created"]);
    });

    it("a stay with a different UID and no reservation code in the feed is not provably a move, so it still alerts", async () => {
      stubFeed(ics([{ uid: "fresh-uid", start: "2026-10-12", end: "2026-10-15", summary: "Reserved" }]));
      const { db } = syncDb(
        { ...baseConnection, last_synced_at: "2026-10-09T11:45:00Z", imported_ranges: [] },
        [{ id: "c2", imported_ranges: [{ ...moved, sourceUid: "old-uid", id: "old-uid" }] }],
      );
      await syncChannelCalendarConnection(db, "c1");
      expect(eventsOf()).toEqual(["channel_booking_created"]);
    });

    it("is quiet in EITHER sync order: the losing room reads the live feed, and records what it released", async () => {
      // Room A (c1) loses the stay and syncs FIRST - before room B has stored anything. Only B's live
      // feed can say the stay moved there.
      const bUrl = "https://www.airbnb.com/calendar/ical/room-b.ics?s=abc";
      // A's own feed still carries an event (a host block), so the "empty feed cancels nothing" rule is
      // not what keeps this quiet.
      stubFeeds({
        "123.ics": ics([{ uid: "blk", start: "2026-10-20", end: "2026-10-22", summary: "Airbnb (Not available)" }]),
        "room-b.ics": ics([{ uid: "uid-moved", start: "2026-10-12", end: "2026-10-15", summary: "Reserved" }]),
      });
      const a = syncDb(
        { ...baseConnection, last_synced_at: "2026-10-09T11:45:00Z", imported_ranges: [moved] },
        [{ id: "c2", property_id: "p2", imported_ranges: [], import_url: bUrl }],
      );
      await syncChannelCalendarConnection(a.db, "c1");
      expect(emitActionEvent).not.toHaveBeenCalled();
      // A wrote what left ITS feed onto its own row, so any instance running B's sync can read it.
      const released = (a.stored as { released_identities?: Record<string, string> }).released_identities ?? {};
      expect(Object.keys(released).sort()).toEqual(["code:HMMOVED123", "uid:uid-moved"]);

      // Then room B syncs and sees the stay as new. A no longer holds it, so only what A recorded keeps
      // this quiet - and B is a different process here: it reads A's stored row, not a shared map.
      stubFeeds({ "room-b.ics": ics([{ uid: "uid-moved", start: "2026-10-12", end: "2026-10-15", summary: "Reserved" }]) });
      const b = syncDb(
        { ...baseConnection, id: "c2", room_id: "r2", property_id: "p2", import_url: bUrl, last_synced_at: "2026-10-09T11:45:00Z", imported_ranges: [] },
        [{ id: "c1", property_id: "p1", imported_ranges: [], import_url: baseConnection.import_url, released_identities: released }],
      );
      await syncChannelCalendarConnection(b.db, "c2");
      expect(emitActionEvent).not.toHaveBeenCalled();
    });

    it("forgets what another room released over an hour ago: a stay that comes back is news again", async () => {
      stubFeeds({ "123.ics": ics([{ uid: "uid-moved", start: "2026-10-12", end: "2026-10-15", summary: "Reserved" }]) });
      const stale = new Date(Date.now() - 61 * 60_000).toISOString();
      const { db } = syncDb(
        { ...baseConnection, last_synced_at: "2026-10-09T11:45:00Z", imported_ranges: [] },
        [{ id: "c2", property_id: "p2", imported_ranges: [], released_identities: { "uid:uid-moved": stale } }],
      );
      await syncChannelCalendarConnection(db, "c1");
      expect(eventsOf()).toEqual(["channel_booking_created"]);
    });

    it("a stay released in ANOTHER workspace of the same manager never suppresses this one's alert", async () => {
      stubFeeds({ "123.ics": ics([{ uid: "uid-moved", start: "2026-10-12", end: "2026-10-15", summary: "Reserved" }]) });
      const { db } = syncDb(
        { ...baseConnection, last_synced_at: "2026-10-09T11:45:00Z", imported_ranges: [] },
        [{ id: "c9", property_id: "p-elsewhere", imported_ranges: [], released_identities: { "uid:uid-moved": new Date().toISOString() } }],
      );
      await syncChannelCalendarConnection(db, "c1");
      expect(eventsOf()).toEqual(["channel_booking_created"]);
    });

    it("stops sweeping sibling feeds as soon as the vanished stay is accounted for", async () => {
      // Ten rooms, and the FIRST one the sweep reads (most recently synced) carries the stay.
      const feeds = stubFeeds({
        "123.ics": ics([{ uid: "blk", start: "2026-10-20", end: "2026-10-22", summary: "Airbnb (Not available)" }]),
        "room-0.ics": ics([{ uid: "uid-moved", start: "2026-10-12", end: "2026-10-15", summary: "Reserved" }]),
      });
      const { db } = syncDb(
        { ...baseConnection, last_synced_at: "2026-10-09T11:45:00Z", imported_ranges: [moved] },
        manyRooms(10),
      );
      await syncChannelCalendarConnection(db, "c1");
      expect(emitActionEvent).not.toHaveBeenCalled();
      const roomReads = feeds.mock.calls.filter(([url]) => String(url).includes("/room-")).length;
      expect(roomReads).toBeGreaterThan(0);
      // One parallel round at most: it never walks the rest of the workspace once it has its answer.
      expect(roomReads).toBeLessThanOrEqual(4);
    });

    it("never reads more than eight sibling feeds in one sync, and still alerts when none carries the stay", async () => {
      const feeds = stubFeeds({ "123.ics": ics([{ uid: "other", start: "2026-11-02", end: "2026-11-04", summary: "Reserved" }]) });
      const { db } = syncDb(
        { ...baseConnection, last_synced_at: "2026-10-09T11:45:00Z", imported_ranges: [moved] },
        manyRooms(12),
      );
      await syncChannelCalendarConnection(db, "c1");
      const roomReads = feeds.mock.calls.filter(([url]) => String(url).includes("/room-")).length;
      expect(roomReads).toBe(8);
      expect(eventsOf().sort()).toEqual(["channel_booking_cancelled", "channel_booking_created"]);
    });

    it("still announces a real cancellation: no other room of the workspace has the stay, stored or live", async () => {
      stubFeeds({ "123.ics": ics([{ uid: "other", start: "2026-11-02", end: "2026-11-04", summary: "Reserved" }]) });
      const { db } = syncDb(
        { ...baseConnection, last_synced_at: "2026-10-09T11:45:00Z", imported_ranges: [moved] },
        [{ id: "c2", property_id: "p2", imported_ranges: [], import_url: "https://www.airbnb.com/calendar/ical/room-b.ics?s=abc" }],
      );
      await syncChannelCalendarConnection(db, "c1");
      expect(eventsOf().sort()).toEqual(["channel_booking_cancelled", "channel_booking_created"]);
    });

    it("a stay held by a connection in ANOTHER workspace of the same manager is a different booking", async () => {
      stubFeeds({ "123.ics": ics([{ uid: "other", start: "2026-11-02", end: "2026-11-04", summary: "Reserved" }]) });
      const { db } = syncDb(
        { ...baseConnection, last_synced_at: "2026-10-09T11:45:00Z", imported_ranges: [moved] },
        [{ id: "c9", property_id: "p-elsewhere", imported_ranges: [moved] }],
      );
      await syncChannelCalendarConnection(db, "c1");
      expect(eventsOf()).toContain("channel_booking_cancelled");
    });

    it("a genuinely new booking, with nothing like it anywhere else, still alerts", async () => {
      stubFeed(ics([{ uid: "brand-new", start: "2026-10-12", end: "2026-10-15", summary: "Reserved" }]));
      const { db } = syncDb(
        { ...baseConnection, last_synced_at: "2026-10-09T11:45:00Z", imported_ranges: [] },
        [{ id: "c2", imported_ranges: [moved] }],
      );
      await syncChannelCalendarConnection(db, "c1");
      expect(eventsOf()).toEqual(["channel_booking_created"]);
    });
  });
});
