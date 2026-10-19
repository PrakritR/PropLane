// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BookingsPortfolioTimeline } from "@/components/portal/bookings-portfolio-timeline";
import { layoutRoom, placeBars, turnoverLabel, turnoverStripPx, TURNOVER_MIN_GAP_PX } from "@/components/portal/bookings-timeline-layout";
import { entryMoments, entryStayTimes, paidAddOnGlyphLabel, stayTitleLine, turnoverCleaningKey } from "@/components/portal/bookings-stay-times";
import { turnoverKeysFromRuns } from "@/hooks/use-turnover-cleaning-runs";
import { DEFAULT_PROPERTY_STAY_TIMES, normalizePropertyStayTimes } from "@/lib/bookings/stay-times";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
import type { OccupancyCapacities } from "@/lib/occupancy/snapshot";

const TODAY = new Date(2026, 9, 18); // Oct 18, 2026
const CAPACITIES: OccupancyCapacities = { bedsTotal: () => 1, roomCapacity: () => 1 };
const DAYS = Array.from({ length: 14 }, (_, index) => `2026-10-${String(12 + index).padStart(2, "0")}`); // Oct 12 - Oct 25
const ROOM = { id: "room-1", label: "Room 1", rent: "" };

// `end` is the LAST night; checkout is the next day.
function stay(id: string, start: string, end: string, extra: Record<string, unknown> = {}): PropertyBookingEntry {
  return { source: "block", blockId: id, propertyId: "h1", propertyLabel: "House", roomId: ROOM.id, roomLabel: "Room 1", summary: id, residentName: id, bookingStatus: "confirmed", start, end, ...extra } as PropertyBookingEntry;
}

const layout = (all: PropertyBookingEntry[], times = DEFAULT_PROPERTY_STAY_TIMES) =>
  layoutRoom({ room: ROOM, all, view: "month", days: DAYS, anchor: "2026-10-12", propertyId: "h1", capacities: CAPACITIES, entryKey: entry => entry.blockId ?? entry.summary, times });
const bar = (result: ReturnType<typeof layout>, id: string) => result.bars.find(item => item.key === id)!;

describe("half-day bar spans", () => {
  it("check-in at or after noon starts mid-cell; check-out at or before noon ends mid-cell", () => {
    const result = layout([stay("a", "2026-10-14", "2026-10-15")]); // in Oct 14 3 pm, out Oct 16 11 am
    expect(bar(result, "a")).toMatchObject({ start: 2.5, end: 4.5 });
  });

  it("check-in before noon starts at the cell start; check-out after noon ends at the cell end", () => {
    const result = layout([stay("a", "2026-10-14", "2026-10-15", { checkInTime: "09:00", checkOutTime: "13:00" })]);
    expect(bar(result, "a")).toMatchObject({ start: 2, end: 5 });
  });

  it("an open-ended stay runs to the end of the range", () => {
    const result = layout([stay("a", "2026-10-14", "2026-12-31", { openEnded: true })]);
    expect(bar(result, "a").end).toBe(DAYS.length);
  });

  it("a stay checking out on the first day still draws its morning half", () => {
    const result = layout([stay("a", "2026-10-10", "2026-10-11")]); // out Oct 12 11 am
    expect(bar(result, "a")).toMatchObject({ start: 0, end: 0.5 });
  });

  it("placeBars leaves a gap of at least 6px at a turnover, and the cleaning block fills exactly that gap", () => {
    const result = layout([stay("a", "2026-10-14", "2026-10-15"), stay("b", "2026-10-16", "2026-10-18")]);
    const [first, second] = placeBars(result.bars, 40, DAYS.length * 40, result.turnovers);
    const gap = second!.left - (first!.left + first!.width);
    expect(gap).toBeGreaterThanOrEqual(TURNOVER_MIN_GAP_PX);
    const strip = turnoverStripPx(result.turnovers[0]!, 40);
    expect(strip.left).toBeCloseTo(first!.left + first!.width, 5);
    expect(strip.left + strip.width).toBeCloseTo(second!.left, 5);
  });

  it("a longer gap (4 h, or one spanning cells) makes the block span checkout x to the next check-in x", () => {
    const result = layout([stay("a", "2026-10-14", "2026-10-15"), stay("b", "2026-10-17", "2026-10-18", { checkInTime: "09:00" })]); // out Oct 16 11 am, in Oct 17 9 am
    const [first, second] = placeBars(result.bars, 40, DAYS.length * 40, result.turnovers);
    const strip = turnoverStripPx(result.turnovers[0]!, 40);
    expect(strip.width).toBeGreaterThan(TURNOVER_MIN_GAP_PX);
    expect(strip.left).toBeCloseTo(first!.left + first!.width, 5);
    expect(strip.left + strip.width).toBeCloseTo(second!.left, 5);
  });
});

describe("same-day turnover", () => {
  const turnover = () => layout([stay("out", "2026-10-14", "2026-10-15"), stay("in", "2026-10-16", "2026-10-18")]); // out Oct 16 11 am, in Oct 16 3 pm

  it("is two half bars in one lane, never a conflict", () => {
    const result = turnover();
    expect(result.bars).toHaveLength(2);
    expect(new Set(result.bars.map(item => item.lane))).toEqual(new Set([0]));
    expect(result.bars.every(item => !item.conflict)).toBe(true);
    expect(bar(result, "out").end).toBe(4.5);
    expect(bar(result, "in").start).toBe(4.5);
    expect(result.height).toBe(52);
  });

  it("a real time overlap is a conflict in separate lanes", () => {
    const result = layout([stay("first", "2026-10-14", "2026-10-16"), stay("second", "2026-10-16", "2026-10-18")]); // first out Oct 17 11 am, second in Oct 16 3 pm
    expect(result.bars.every(item => item.conflict)).toBe(true);
    expect(new Set(result.bars.map(item => item.lane)).size).toBe(2);
  });

  it("a 1 pm late checkout before a 3 pm check-in is no conflict, and the bars meet instead of overlapping", () => {
    const result = layout([stay("out", "2026-10-14", "2026-10-15", { checkOutTime: "13:00" }), stay("in", "2026-10-16", "2026-10-18")]);
    expect(result.bars.every(item => !item.conflict)).toBe(true);
    expect(bar(result, "out").end).toBeLessThanOrEqual(bar(result, "in").start);
  });

  it("an early check-in that lands before the previous guest leaves IS a conflict", () => {
    const result = layout([stay("out", "2026-10-14", "2026-10-15"), stay("in", "2026-10-16", "2026-10-18", { checkInTime: "10:00" })]); // in 10 am, out 11 am
    expect(result.bars.every(item => item.conflict)).toBe(true);
  });
});

describe("turnover gaps", () => {
  it("the gap spans checkout to the next check-in with the cleaning window on its label", () => {
    const result = layout([stay("out", "2026-10-14", "2026-10-15"), stay("in", "2026-10-16", "2026-10-18")]);
    // Each guest has a turnover after them; the last one has no next guest, so its window is checkout + buffer.
    expect(result.turnovers.map(item => item.key)).toEqual(["out", "in"]);
    const gap = result.turnovers[0]!;
    expect(gap).toMatchObject({ key: "out", short: false, gapMinutes: 240, outTime: "11:00", endTime: "15:00" });
    expect(gap!.start).toBe(4.5);
    expect(gap!.end).toBe(4.5);
    expect(turnoverLabel(gap!, true)).toBe("Cleaning · 11:00 am – 3:00 pm");
  });

  it("is short when the next guest arrives inside the property's buffer, and says so", () => {
    const result = layout([stay("out", "2026-10-14", "2026-10-15", { checkOutTime: "13:00" }), stay("in", "2026-10-16", "2026-10-18")]);
    const [gap] = result.turnovers;
    expect(gap).toMatchObject({ short: true, gapMinutes: 120, bufferMinutes: 180 });
    expect(turnoverLabel(gap!, false)).toBe("Turnover 2 h · shorter than the 3 h cleaning buffer");
  });

  it("reads the buffer from the property's own times", () => {
    const times = normalizePropertyStayTimes({ cleaningBufferMinutes: 60 });
    const result = layout([stay("out", "2026-10-14", "2026-10-15", { checkOutTime: "13:00" }), stay("in", "2026-10-16", "2026-10-18")], times);
    expect(result.turnovers[0]!.short).toBe(false);
  });

  it("a closed room is not a guest, so there is no turnover beside it", () => {
    const result = layout([stay("out", "2026-10-14", "2026-10-15"), stay("closed", "2026-10-16", "2026-10-18", { blockKind: "closed", residentName: undefined, bookingStatus: undefined, summary: "Painting" })]);
    expect(result.turnovers[0]?.next ?? null).toBeNull();
  });

  it("with no next guest the window is checkout plus the buffer", () => {
    const result = layout([stay("out", "2026-10-14", "2026-10-15")]);
    expect(result.turnovers[0]).toMatchObject({ short: false, gapMinutes: null, endTime: "14:00" });
  });
});

describe("cleaning strips in the timeline", () => {
  beforeEach(() => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("pointer: fine"), media: query, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true }));
    localStorage.clear();
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  const outgoing = stay("out", "2026-10-14", "2026-10-17"); // out Oct 18 11 am
  const incoming = stay("in", "2026-10-18", "2026-10-20"); // in Oct 18 3 pm
  const mount = (entries: PropertyBookingEntry[], extra: Partial<React.ComponentProps<typeof BookingsPortfolioTimeline>> = {}) =>
    render(<BookingsPortfolioTimeline propertyIds={["h1"]} entries={entries} today={TODAY} resolveRooms={() => [ROOM]} resolveHouse={() => ({ name: "House" })} resolveTimes={() => DEFAULT_PROPERTY_STAY_TIMES} capacities={CAPACITIES} preferenceKey="half-day" {...extra} />);
  const strips = () => [...document.querySelectorAll('[data-attr="bookings-turnover"]')];

  it("draws nothing for a plain turnover with no cleaning job", () => {
    mount([outgoing, incoming]);
    expect(strips()).toHaveLength(0);
  });

  it("draws a hatched cleaning strip when a job exists", () => {
    mount([outgoing, incoming], { cleaningKeys: new Set([turnoverCleaningKey(outgoing)!]) });
    expect(strips()).toHaveLength(1);
    expect(strips()[0]!.getAttribute("aria-label")).toBe("Cleaning · 11:00 am – 3:00 pm");
    expect(strips()[0]!.getAttribute("data-turnover")).toBe("cleaning");
    expect((strips()[0] as HTMLElement).style.height).toBe("32px"); // full bar height
  });

  it("draws red for a short gap even with no job", () => {
    mount([stay("out", "2026-10-14", "2026-10-17", { checkOutTime: "13:00" }), incoming]);
    expect(strips()).toHaveLength(1);
    expect(strips()[0]!.getAttribute("data-turnover")).toBe("short");
    expect(strips()[0]!.getAttribute("aria-label")).toBe("Turnover 2 h · shorter than the 3 h cleaning buffer");
  });
});

describe("tap text and the clock glyph", () => {
  const brandi = stay("brandi", "2026-10-16", "2026-10-18", { residentName: "Brandi", summary: "Brandi" }); // in Oct 16 3 pm, out Oct 19 11 am

  it("the title line reads the guest and the checkout moment; the check-in is its own fact", () => {
    const moments = entryMoments(brandi, entryStayTimes(brandi));
    expect(stayTitleLine("Brandi", moments)).toBe("Brandi · out Oct 19, 11:00 am");
    expect(moments.inLabel).toBe("Oct 16, 3:00 pm");
  });

  it("an open-ended stay has no checkout moment", () => {
    const lease = stay("lease", "2026-10-16", "2026-12-31", { openEnded: true });
    expect(stayTitleLine("Lease", entryMoments(lease, entryStayTimes(lease)))).toBe("Lease");
  });

  it("an explicit time beats the property default and the legacy sheet field", () => {
    expect(entryStayTimes(stay("a", "2026-10-16", "2026-10-17", { checkInTime: "12:00" }))).toEqual({ checkInTime: "12:00", checkOutTime: "11:00" });
    expect(entryStayTimes(stay("a", "2026-10-16", "2026-10-17", { stayDetails: { earlyCheckIn: "13:30" } }))).toEqual({ checkInTime: "13:30", checkOutTime: "11:00" });
  });

  it("the clock glyph shows only for a PAID add-on, named for it", () => {
    const addOn = (status: string) => ({ addOns: { early_check_in: { time: "12:00", priceCents: 2500, status } } });
    expect(paidAddOnGlyphLabel(stay("a", "2026-10-16", "2026-10-17", addOn("paid")))).toBe("Early check-in 12:00 pm");
    for (const status of ["requested", "pending", "refunded"]) expect(paidAddOnGlyphLabel(stay("a", "2026-10-16", "2026-10-17", addOn(status)))).toBeNull();
    expect(paidAddOnGlyphLabel(stay("a", "2026-10-16", "2026-10-17"))).toBeNull();
  });

  describe("in the timeline", () => {
    beforeEach(() => {
      vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("pointer: fine"), media: query, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true }));
      localStorage.clear();
    });
    afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
    const mount = (entries: PropertyBookingEntry[]) =>
      render(<BookingsPortfolioTimeline propertyIds={["h1"]} entries={entries} today={TODAY} resolveRooms={() => [ROOM]} resolveHouse={() => ({ name: "House" })} resolveTimes={() => DEFAULT_PROPERTY_STAY_TIMES} capacities={CAPACITIES} preferenceKey="half-day-tap" />);

    it("the bar's aria-label carries both times; a paid early check-in draws the glyph before the name", () => {
      mount([{ ...brandi, addOns: { early_check_in: { time: "12:00", priceCents: 2500, status: "paid" } } } as PropertyBookingEntry]);
      const button = document.querySelector('[data-attr="bookings-calendar-bar"]')!;
      expect(button.getAttribute("aria-label")).toBe("Brandi, In-house, in Oct 16, 3:00 pm, out Oct 19, 11:00 am");
      const glyph = button.querySelector('[data-attr="bookings-bar-addon-glyph"]')!;
      expect(glyph.getAttribute("aria-label")).toBe("Early check-in 12:00 pm");
    });

    it("no glyph without a paid add-on", () => {
      mount([brandi]);
      expect(document.querySelector('[data-attr="bookings-bar-addon-glyph"]')).toBeNull();
    });

    it("the popover title reads 'Brandi · out Oct 19, 11:00 am' with the check-in fact", async () => {
      mount([brandi]);
      fireEvent.pointerDown(document.querySelector('[data-attr="bookings-calendar-bar"]')!, { button: 0 });
      expect((await screen.findByText("Brandi · out Oct 19, 11:00 am"))).toBeTruthy();
      const facts = [...document.querySelectorAll('[data-attr="bookings-bar-facts"] > div')].map(row => [...row.children].map(cell => cell.textContent));
      expect(facts.slice(0, 2)).toEqual([["Check-in", "Oct 16, 3:00 pm"], ["Check-out", "Oct 19, 11:00 am"]]);
    });

    it("the phone sheet lists Check-in, Check-out and a paid add-on as ordinary fact rows beside Dates, Room and Status", async () => {
      vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("max-width: 639px"), media: query, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true }));
      mount([{ ...brandi, addOns: { early_check_in: { time: "12:00", priceCents: 2500, status: "paid" } } } as PropertyBookingEntry]);
      fireEvent.click(document.querySelector('[data-attr="bookings-calendar-bar"]')!);
      await screen.findByText("Open booking");
      const facts = [...document.querySelectorAll('[data-attr="bookings-bar-sheet"] [data-attr="bookings-bar-facts"] > div')].map(row => [...row.children].map(cell => cell.textContent));
      expect(facts.map(row => row[0])).toEqual(["Check-in", "Check-out", "Early check-in", "Dates", "Room", "Status"]);
      expect(facts[2]).toEqual(["Early check-in", "12:00 pm · $25 paid"]);
    });
  });
});

describe("cleaning runs read", () => {
  it("maps live cleaning runs to their turnover keys and ignores dead ones", () => {
    const keys = turnoverKeysFromRuns({ runs: [
      { sourceType: "cleaning", sourceId: "block:b1:2026-10-19", status: "offering" },
      { sourceType: "cleaning", sourceId: "block:b2:2026-10-19", status: "canceled" },
      { sourceType: "cleaning", sourceId: "block:b3:2026-10-19", status: "accepted" },
      { sourceType: "service_request", sourceId: "x", status: "offering" },
    ] });
    expect([...keys].sort()).toEqual(["block:b1:2026-10-19", "block:b3:2026-10-19"]);
    expect(turnoverKeysFromRuns(null).size).toBe(0);
  });

  it("a block's key is block:<id>:<checkout date>", () => {
    expect(turnoverCleaningKey(stay("b1", "2026-10-16", "2026-10-18"))).toBe("block:b1:2026-10-19");
  });
});
