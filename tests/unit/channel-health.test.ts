// Plan channels-sync-1027 GAP 4 + GAP 5: stale feeds (D2, 6h), missing echoes, long closures, Reopen, the post text.
import { describe, expect, it } from "vitest";
import {
  buildAttentionItems,
  FEED_STALE_AFTER_HOURS,
  FEED_STALE_AFTER_MS,
  feedStateFor,
  reopenClosureEdit,
  type HealthConnection,
  type HealthStay,
} from "@/lib/channel-calendar/channel-health";
import { advertisedVacancy, buildVacancyPost, type VacancyRoom } from "@/lib/channel-calendar/vacancy-post";
import { bookingNoticeRollKey, groupNoticesByBooking } from "@/lib/booking-notice-roll";

const NOW = new Date("2026-10-27T20:00:00Z");
const TODAY = "2026-10-27";
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

const airbnb = (extra: Partial<HealthConnection> = {}): HealthConnection => ({
  id: "conn-r4", propertyId: "p5257", roomId: "r4", roomLabel: "Room 4", provider: "airbnb", label: null,
  lastSyncedAt: hoursAgo(1), lastError: null, exportLastFetchedAt: hoursAgo(2), ranges: [], ...extra,
});
const stay = (extra: Partial<HealthStay> = {}): HealthStay => ({
  id: "blk-1", propertyId: "p5257", roomId: "r4", roomLabel: "Room 4", name: "Direct guest", reason: "Direct",
  checkIn: "2026-10-27", checkOut: "2026-10-30", openEnded: false, cancelled: false, closed: false, createdAt: hoursAgo(10), ...extra,
});

describe("feed health (D2: 6 hours)", () => {
  it("the threshold is the decided 6 hours", () => {
    expect(FEED_STALE_AFTER_HOURS).toBe(6);
    expect(FEED_STALE_AFTER_MS).toBe(6 * 3_600_000);
  });

  it("a channel that read the feed 5 hours ago is fine; 7 hours ago raises an item; a new fetch clears it", () => {
    expect(feedStateFor(airbnb({ exportLastFetchedAt: hoursAgo(5) }), NOW)).toBe("fetched");
    expect(feedStateFor(airbnb({ exportLastFetchedAt: hoursAgo(7) }), NOW)).toBe("stale");
    const stale = buildAttentionItems({ connections: [airbnb({ exportLastFetchedAt: hoursAgo(9) })], stays: [], now: NOW, today: TODAY });
    expect(stale).toEqual([expect.objectContaining({ kind: "stale_feed", text: "Airbnb · Room 4 has not read PropLane's calendar in 9 hours" })]);
    expect(buildAttentionItems({ connections: [airbnb({ exportLastFetchedAt: hoursAgo(0.2) })], stays: [], now: NOW, today: TODAY })).toEqual([]);
  });

  it("a feed Airbnb never read, on a link synced for longer than the threshold, is flagged; a brand-new link is not", () => {
    expect(feedStateFor(airbnb({ exportLastFetchedAt: null, lastSyncedAt: hoursAgo(30) }), NOW)).toBe("never");
    expect(feedStateFor(airbnb({ exportLastFetchedAt: null, lastSyncedAt: hoursAgo(1) }), NOW)).toBe("waiting");
    expect(feedStateFor(airbnb({ exportLastFetchedAt: null, lastSyncedAt: null }), NOW)).toBe("waiting");
  });

  it("an export that failed is an item of its own; a channel that does not identify its crawler is never called stale", () => {
    expect(feedStateFor(airbnb({ lastError: "Export feed failed: connection read failed" }), NOW)).toBe("error");
    expect(feedStateFor(airbnb({ provider: "booking_com", exportLastFetchedAt: hoursAgo(99) }), NOW)).toBe("unmonitored");
  });
});

describe("missing echo (one poll)", () => {
  const polled = { exportLastFetchedAt: hoursAgo(3), lastSyncedAt: hoursAgo(1) };

  it("a stay that existed when Airbnb read the feed but is not in Airbnb's calendar is flagged", () => {
    const items = buildAttentionItems({ connections: [airbnb(polled)], stays: [stay()], now: NOW, today: TODAY });
    expect(items.map((item) => item.kind)).toEqual(["missing_echo"]);
    expect(items[0]!.text).toBe("Room 4: Direct guest (Oct 27 – Oct 29) is not on Airbnb yet");
  });

  it("is quiet once Airbnb's feed carries the stay (a host block echo covers its nights)", () => {
    const echo = airbnb({ ...polled, ranges: [{ start: "2026-10-27", end: "2026-10-30", hostBlock: true, summary: "Airbnb (Not available)" }] });
    expect(buildAttentionItems({ connections: [echo], stays: [stay()], now: NOW, today: TODAY })).toEqual([]);
  });

  it("is quiet before Airbnb has read the feed since the stay was made, and before PropLane has synced after that read", () => {
    expect(buildAttentionItems({ connections: [airbnb(polled)], stays: [stay({ createdAt: hoursAgo(1) })], now: NOW, today: TODAY })).toEqual([]);
    const notSynced = airbnb({ exportLastFetchedAt: hoursAgo(1), lastSyncedAt: hoursAgo(1.2) });
    expect(buildAttentionItems({ connections: [notSynced], stays: [stay()], now: NOW, today: TODAY })).toEqual([]);
  });

  it("ignores a cancelled stay, a past stay, another room's stay, and a stay Airbnb itself brought in", () => {
    const stays = [
      stay({ id: "a", cancelled: true }),
      stay({ id: "b", checkIn: "2026-10-01", checkOut: "2026-10-05" }),
      stay({ id: "c", roomId: "r9" }),
      stay({ id: "d", reason: "Airbnb" }),
    ];
    expect(buildAttentionItems({ connections: [airbnb(polled)], stays, now: NOW, today: TODAY })).toEqual([]);
  });
});

describe("long closures (GAP 5)", () => {
  it("an open-ended manager closure becomes an item with Reopen", () => {
    const closed = stay({ id: "blk-closed", name: "", reason: "Repairs", closed: true, checkIn: "2026-09-30", checkOut: "9999-12-31", openEnded: true, roomLabel: "Room 2", roomId: "r2" });
    const items = buildAttentionItems({ connections: [], stays: [closed], now: NOW, today: TODAY });
    expect(items).toEqual([expect.objectContaining({ kind: "manager_closure", text: "Room 2 has been closed since Sep 30 with no end date", action: { kind: "reopen", blockId: "blk-closed" } })]);
  });

  it("a short closure, a stay with a guest's name, and a cancelled closure are not items", () => {
    const short = stay({ id: "s", closed: true, name: "", reason: "Paint", checkIn: "2026-10-20", checkOut: "2026-10-30" });
    const named = stay({ id: "n", checkIn: "2026-09-01", checkOut: "9999-12-31", openEnded: true });
    const cancelled = stay({ id: "c", closed: true, name: "", reason: "Paint", checkIn: "2026-09-01", checkOut: "9999-12-31", openEnded: true, cancelled: true });
    expect(buildAttentionItems({ connections: [], stays: [short, named, cancelled], now: NOW, today: TODAY })).toEqual([]);
  });

  it("a year-long closure on the channel becomes Open on Airbnb", () => {
    const channelClosure = airbnb({
      exportLastFetchedAt: hoursAgo(1),
      roomLabel: "Room 9",
      ranges: [{ start: "2026-10-26", end: "2027-10-27", hostBlock: true, summary: "Airbnb (Not available)" }],
    });
    const items = buildAttentionItems({ connections: [channelClosure], stays: [], now: NOW, today: TODAY });
    expect(items).toEqual([expect.objectContaining({ kind: "channel_closure", text: "Room 9 is closed on Airbnb until Oct 28, 2027", action: { kind: "open_on_channel", provider: "airbnb" } })]);
  });

  it("Reopen ends a started closure today and cancels one that has not started", () => {
    expect(reopenClosureEdit({ checkIn: "2026-09-30", openEnded: true }, TODAY)).toEqual({ openEnded: false, checkOut: TODAY });
    expect(reopenClosureEdit({ checkIn: "2026-11-02" }, TODAY)).toEqual({ bookingStatus: "cancelled" });
  });
});

describe("the post a manager pastes", () => {
  const room = (name: string, kind: VacancyRoom["status"]["kind"], text: string, date?: string): VacancyRoom => ({ roomId: name, name, rentLabel: "$1,100/mo", status: { kind, text, date } });
  const rooms = [room("Room 3", "leased", "Leased until Aug 31, 2027"), room("Room 5", "soon", "Available Nov 14", "2026-11-14"), room("Room 2", "now", "Available now"), room("Room 8", "closed", "Not available")];

  it("lists only rooms a renter can fill soon, open now first, and never a leased room", () => {
    expect(advertisedVacancy(rooms).map((r) => r.name)).toEqual(["Room 2", "Room 5"]);
  });

  it("carries the live labels and the number it is handed", () => {
    expect(buildVacancyPost({ houseLabel: "5257 Brooklyn", rooms, workNumber: "(206) 555-0100" })).toBe(
      ["5257 Brooklyn: 2 rooms open", "Room 2 · $1,100/mo · Available now", "Room 5 · $1,100/mo · Available Nov 14", "Text (206) 555-0100"].join("\n"),
    );
    expect(buildVacancyPost({ houseLabel: "5259", rooms: [rooms[0]!], workNumber: null })).toBe("5259: no rooms open right now.");
  });
});

describe("booking notices roll over per booking (D3)", () => {
  it("one reservation's booking, change and check-out notices share a key; another reservation does not", () => {
    const a = bookingNoticeRollKey("airbnb:p5257:r4:HMABC");
    expect(a).toBe(bookingNoticeRollKey("airbnb:p5257:r4:HMABC"));
    expect(a).not.toBe(bookingNoticeRollKey("airbnb:p5257:r4:HMXYZ"));
    expect(bookingNoticeRollKey("")).toBeNull();
    expect(bookingNoticeRollKey(undefined)).toBeNull();
  });

  it("groups a thread's notices by booking and leaves non-booking notices out", () => {
    const k1 = bookingNoticeRollKey("one")!;
    const k2 = bookingNoticeRollKey("two")!;
    const groups = groupNoticesByBooking([
      { id: "m1", rollKey: k1 }, { id: "m2", rollKey: k2 }, { id: "m3", rollKey: k1 }, { id: "m4" },
    ]);
    expect([...groups.get(k1)!.map((m) => m.id)]).toEqual(["m1", "m3"]);
    expect([...groups.get(k2)!.map((m) => m.id)]).toEqual(["m2"]);
    expect(groups.size).toBe(2);
  });
});
