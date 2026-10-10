import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const emitActionEvent = vi.fn<(db: unknown, input: unknown) => Promise<unknown>>(async () => ({ eventId: "e", duplicate: false, delivered: 1, submitted: 0, deferred: 0, failed: 0 }));
vi.mock("@/lib/action-events.server", () => ({ emitActionEvent: (db: unknown, input: unknown) => emitActionEvent(db, input) }));
const track = vi.fn();
vi.mock("@/lib/analytics/posthog", () => ({ track: (...args: unknown[]) => track(...args) }));
vi.mock("@/lib/channel-calendar/airbnb-residents.server", () => ({ upsertAirbnbResidentsFromImportedRanges: async () => undefined }));
vi.mock("@/lib/channel-calendar/stay-tombstones.server", () => ({ loadChannelStayTombstoneKeys: async () => new Set<string>() }));

import { diffChannelReservations } from "@/lib/channel-calendar/channel-booking-diff";
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

function syncDb(connection: Record<string, unknown>) {
  const stored = { ...connection };
  const from = (table: string) => {
    let patch: Record<string, unknown> | null = null;
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      update: (value: Record<string, unknown>) => { patch = value; if (table === "external_calendar_connections") Object.assign(stored, value); return chain; },
      maybeSingle: async () => table === "external_calendar_connections"
        ? { data: stored, error: null }
        : table === "profiles"
          ? { data: { email: "m@example.com", full_name: "Mgr" }, error: null }
          : { data: { manager_user_id: "m1", property_data: { id: "p1", title: "5259 Brooklyn Ave", buildingName: "5259 Brooklyn Ave", listingSubmission: { rooms: [{ id: "r1", name: "Room 3", manualUnavailableRanges: [] }] } }, row_data: {} }, error: null },
      single: async () => ({ data: stored, error: null }),
      then: (resolve: (value: unknown) => void) => resolve({ error: null, data: patch }),
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

  it("a failing alert never fails the sync", async () => {
    emitActionEvent.mockRejectedValueOnce(new Error("bus down"));
    stubFeed(ics([{ uid: "new", start: "2026-10-12", end: "2026-10-15", summary: "Reserved" }]));
    const { db } = syncDb({ ...baseConnection, last_synced_at: "2026-10-09T11:45:00Z", imported_ranges: [] });
    await expect(syncChannelCalendarConnection(db, "c1")).resolves.toMatchObject({ id: "c1" });
  });
});
