import { describe, expect, it } from "vitest";

import {
  checkBulkRows,
  copyAllLinksText,
  draftsFromBulkRows,
  mapWithConcurrency,
  matchLinksToRooms,
  parsePastedLinks,
  type BulkRow,
} from "@/lib/channel-calendar/link-bulk";

const airbnb = (n: number) => `https://www.airbnb.com/calendar/ical/${1000 + n}.ics?s=abc${n}`;
const rooms = Array.from({ length: 10 }, (_, i) => ({ key: `p::r${i + 1}`, label: `Room ${i + 1}`, filled: false }));

describe("Paste many: parsing", () => {
  it("reads one link per find from bare lines, labelled lines, bullets and several to a line", () => {
    const text = [airbnb(1), `Room 2: ${airbnb(2)}`, `- ${airbnb(3)}.`, `${airbnb(4)}, ${airbnb(5)}`, "", "not a link"].join("\n");
    expect(parsePastedLinks(text)).toEqual([airbnb(1), airbnb(2), airbnb(3), airbnb(4), airbnb(5)]);
  });

  it("is empty for text with no link, and caps a runaway paste", () => {
    expect(parsePastedLinks("hello\nworld")).toEqual([]);
    expect(parsePastedLinks(Array.from({ length: 500 }, (_, i) => airbnb(i)).join("\n"))).toHaveLength(120);
  });
});

describe("Paste many: matching to rooms in display order", () => {
  it("10 links go to the first 10 rooms in order", () => {
    const links = Array.from({ length: 10 }, (_, i) => airbnb(i + 1));
    expect(matchLinksToRooms(links, rooms)).toEqual(rooms.map((room) => room.key));
  });

  it("rooms with no link yet are taken before rooms that already have one", () => {
    const partly = rooms.map((room, i) => ({ ...room, filled: i < 2 }));
    expect(matchLinksToRooms([airbnb(1), airbnb(2)], partly)).toEqual(["p::r3", "p::r4"]);
  });

  it("a link with no room left stays unassigned", () => {
    expect(matchLinksToRooms([airbnb(1), airbnb(2), airbnb(3)], rooms.slice(0, 2))).toEqual(["p::r1", "p::r2", ""]);
  });
});

describe("Paste many: per-link validation", () => {
  const label = (key: string) => rooms.find((room) => room.key === key)?.label ?? key;
  const rowsFor = (urls: string[]): BulkRow[] => urls.map((url, i) => ({ id: String(i), url, roomKey: rooms[i]!.key }));

  it("10 links, one from the wrong host: only that one is rejected, with the channel's own message", () => {
    const urls = Array.from({ length: 10 }, (_, i) => airbnb(i + 1));
    urls[6] = "https://evil.example.com/calendar/ical/7.ics";
    const rows = rowsFor(urls);
    const checks = checkBulkRows("airbnb", rows, label);
    const bad = rows.filter((row) => checks.get(row.id)?.ok === false);
    expect(bad.map((row) => row.id)).toEqual(["6"]);
    expect(checks.get("6")).toMatchObject({ ok: false, error: expect.stringContaining("not an Airbnb calendar link") });
    expect(Object.keys(draftsFromBulkRows(rows, checks))).toHaveLength(9);
    expect(draftsFromBulkRows(rows, checks)["p::r7"]).toBeUndefined();
  });

  it("an Airbnb link is wrong for Booking.com, and the reverse", () => {
    expect(checkBulkRows("booking_com", rowsFor([airbnb(1)]), label).get("0")).toMatchObject({ ok: false });
    expect(checkBulkRows("booking_com", rowsFor(["https://ical.booking.com/v1/export?t=0123-abcd"]), label).get("0")).toEqual({ ok: true });
  });

  it("the same link twice, or two links for one room, flags the later one", () => {
    const dup = checkBulkRows("airbnb", [
      { id: "a", url: airbnb(1), roomKey: "p::r1" },
      { id: "b", url: airbnb(1), roomKey: "p::r2" },
      { id: "c", url: airbnb(3), roomKey: "p::r1" },
    ], label);
    expect(dup.get("a")).toEqual({ ok: true });
    expect(dup.get("b")).toEqual({ ok: false, error: "Same link as Room 1." });
    expect(dup.get("c")).toEqual({ ok: false, error: "Room 1 already has a link in this list." });
  });

  it("a row with no room is skipped, not wrong, and makes no draft", () => {
    const rows: BulkRow[] = [{ id: "x", url: airbnb(1), roomKey: "" }];
    const checks = checkBulkRows("airbnb", rows, label);
    expect(checks.get("x")).toEqual({ ok: true });
    expect(draftsFromBulkRows(rows, checks)).toEqual({});
  });
});

describe("Copy all PropLane links", () => {
  it("is one 'House · Room: URL' line per room and leaves out a room with no link", () => {
    expect(
      copyAllLinksText([
        { house: "4709A 8th Ave", room: "Room 1", url: "https://proplane.ai/api/calendar/export/a.ics" },
        { house: "4709A 8th Ave", room: "Room 2", url: "" },
        { house: "5259 Brooklyn", room: "Room 1", url: " https://proplane.ai/api/calendar/export/b.ics " },
      ]),
    ).toBe("4709A 8th Ave · Room 1: https://proplane.ai/api/calendar/export/a.ics\n5259 Brooklyn · Room 1: https://proplane.ai/api/calendar/export/b.ics");
  });
});

describe("mapWithConcurrency", () => {
  it("keeps order, bounds the work in flight, and reports a failure without stopping the rest", async () => {
    let active = 0;
    let peak = 0;
    const results = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8], 4, async (n) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      if (n === 3) throw new Error("boom");
      return n * 2;
    });
    expect(peak).toBe(4);
    expect(results.map((r) => (r.ok ? r.value : "x"))).toEqual([2, 4, "x", 8, 10, 12, 14, 16]);
  });
});
