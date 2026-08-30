/**
 * A slotKey is wall time on the tour calendar's clock, never the server's.
 *
 * `slotStartMs` used to build the instant with `new Date(y, m, d)`, which reads
 * the SERVER's zone — Pacific in dev, **UTC on Vercel**. In production that put
 * every slot seven hours off its real time, so `overlaps()` compared a
 * confirmed tour against the wrong half hour and the booked slot stayed on
 * offer. A second prospect could book straight on top of it. Nothing failed
 * loudly; the grid just kept selling a booked window.
 *
 * These run the math under a UTC process zone on purpose: on a Pacific dev
 * machine the bug is invisible, which is exactly how it shipped.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  blockInstantMs,
  buildDefaultTourSlotKeys,
  DEFAULT_TOUR_END_SLOT_EXCLUSIVE,
  DEFAULT_TOUR_HORIZON_DAYS,
  DEFAULT_TOUR_START_SLOT,
  overlaps,
  resolveTourOfferingSlots,
  shouldOfferDefaultTourGrid,
  slotBlocked,
  slotIsBookable,
  slotStartMs,
} from "@/lib/tour-slot-math";

const originalTz = process.env.TZ;

/** Re-run a body with the process pinned to a zone, as a deployed server is. */
function withProcessTimeZone(timeZone: string, body: () => void) {
  process.env.TZ = timeZone;
  try {
    body();
  } finally {
    process.env.TZ = originalTz;
  }
}

describe("slot math is anchored to the tour calendar zone, not the server", () => {
  it("resolves a slot to the same instant under UTC and Pacific processes", () => {
    const underUtc = withReturn("UTC", () => slotStartMs("2026-08-06:20"));
    const underPacific = withReturn("America/Los_Angeles", () => slotStartMs("2026-08-06:20"));
    expect(underUtc).toBe(underPacific);
    // Slot 20 is 10:00 am Pacific; in August that is 17:00 UTC.
    expect(new Date(underUtc!).toISOString()).toBe("2026-08-06T17:00:00.000Z");
  });

  it("blocks a confirmed tour's own slot on a UTC server", () => {
    withProcessTimeZone("UTC", () => {
      // A confirmed 10:00-10:30 am Pacific tour, stored as a real instant.
      const confirmed = { start: "2026-08-06T17:00:00.000Z", end: "2026-08-06T17:30:00.000Z" };
      expect(overlaps("2026-08-06:20", confirmed)).toBe(true);
      expect(slotBlocked("2026-08-06:20", [confirmed])).toBe(true);
      // And it must not spill onto a half hour it does not occupy.
      expect(slotBlocked("2026-08-06:22", [confirmed])).toBe(false);
    });
  });

  it("blocks calendar-busy time that carries no slotKey", () => {
    withProcessTimeZone("UTC", () => {
      // Google busy 7:30-10:00 am Pacific. Busy windows never carry a slotKey,
      // so the exact-match shortcut cannot save this one — only the overlap
      // math can, and under the old server-local math it never matched.
      const busy = { start: "2026-08-04T14:30:00.000Z", end: "2026-08-04T17:00:00.000Z" };
      expect(slotBlocked("2026-08-04:18", [busy])).toBe(true); // 9:00 am
      expect(slotBlocked("2026-08-04:19", [busy])).toBe(true); // 9:30 am
      expect(slotBlocked("2026-08-04:20", [busy])).toBe(false); // 10:00 am — busy has ended
    });
  });

  it("reads a zone-less block timestamp as calendar wall time", () => {
    withProcessTimeZone("UTC", () => {
      // Google returns all-day events as bare dates, and stored payloads carry
      // local-naive ISO strings. `Date.parse` would read these as UTC.
      expect(new Date(blockInstantMs("2026-08-06T09:00:00")).toISOString()).toBe("2026-08-06T16:00:00.000Z");
      expect(new Date(blockInstantMs("2026-08-06T09:00:00Z")).toISOString()).toBe("2026-08-06T09:00:00.000Z");
      expect(new Date(blockInstantMs("2026-08-06T09:00:00-04:00")).toISOString()).toBe("2026-08-06T13:00:00.000Z");
    });
  });

  it("judges past slots on the calendar clock", () => {
    withProcessTimeZone("UTC", () => {
      const tenAmPacific = Date.parse("2026-08-06T17:00:00.000Z");
      expect(slotIsBookable("2026-08-06:20", tenAmPacific)).toBe(true);
      expect(slotIsBookable("2026-08-06:19", tenAmPacific)).toBe(false);
    });
  });
});

describe("the default offering is a 9 am - 5 pm day", () => {
  it("starts at 9:00 am and ends with a window closing at 5:00 pm", () => {
    // Slot n starts at n * 30 minutes past midnight.
    expect(DEFAULT_TOUR_START_SLOT * 30).toBe(9 * 60);
    expect(DEFAULT_TOUR_END_SLOT_EXCLUSIVE * 30).toBe(17 * 60);
  });

  it("offers every half hour of that day, starting today", () => {
    const now = Date.parse("2026-08-04T15:00:00.000Z"); // 8:00 am Pacific
    // A requested horizon is clamped to a 7-day floor, so ask for the floor
    // rather than a shorter window the config layer will not honor.
    const days = 7;
    const keys = buildDefaultTourSlotKeys(now, days);
    const perDay = DEFAULT_TOUR_END_SLOT_EXCLUSIVE - DEFAULT_TOUR_START_SLOT;
    expect(keys).toHaveLength(perDay * days);
    expect(keys[0]).toBe("2026-08-04:18");
    expect(keys[perDay - 1]).toBe("2026-08-04:33");
    // Whole days apart, with no skipped or repeated date.
    expect(keys[perDay]).toBe("2026-08-05:18");
    expect(keys[perDay * 2]).toBe("2026-08-06:18");
  });

  it("never publishes a window shorter than a week", () => {
    // resolveDefaultTourAvailabilityConfig clamps a requested horizon to
    // [7, 60], so a caller asking for a 3-day window still gets seven days.
    // That floor is what makes the shorter horizons elsewhere in this file
    // resolve to the same grid.
    const now = Date.parse("2026-08-04T15:00:00.000Z");
    const perDay = DEFAULT_TOUR_END_SLOT_EXCLUSIVE - DEFAULT_TOUR_START_SLOT;
    expect(buildDefaultTourSlotKeys(now, 3)).toHaveLength(perDay * 7);
  });

  it("builds the same days under a UTC process as a Pacific one", () => {
    // 11:00 pm Pacific — already tomorrow in UTC. A server-local date read here
    // skipped a whole day of the default grid.
    const now = Date.parse("2026-08-05T06:00:00.000Z");
    const underUtc = withReturn("UTC", () => buildDefaultTourSlotKeys(now, 2));
    const underPacific = withReturn("America/Los_Angeles", () => buildDefaultTourSlotKeys(now, 2));
    expect(underUtc).toEqual(underPacific);
    expect(underUtc![0]).toBe("2026-08-04:18");
  });

  it("spans three weeks, not two months", () => {
    // The availability response is `no-store`, so every request pays for the
    // whole grid; 60 days x 16 windows was ~960 slot entries per request.
    expect(DEFAULT_TOUR_HORIZON_DAYS).toBe(21);
  });
});

describe("resolveTourOfferingSlots", () => {
  it("fills the 9-5 default on days with no published windows", () => {
    const now = Date.parse("2026-08-04T15:00:00.000Z");
    const offered = resolveTourOfferingSlots(["2026-08-06:20"], now, 3);
    const byDay = new Map<string, string[]>();
    for (const slot of offered) {
      const day = slot.split(":")[0] ?? "";
      const list = byDay.get(day) ?? [];
      list.push(slot);
      byDay.set(day, list);
    }
    expect(byDay.get("2026-08-06")).toEqual(["2026-08-06:20"]);
    expect(byDay.get("2026-08-04")?.length).toBe(16);
    expect(byDay.get("2026-08-05")?.length).toBe(16);
  });

  it("does not add default windows on a day that already has a published slot", () => {
    const now = Date.parse("2026-08-04T15:00:00.000Z");
    const offered = resolveTourOfferingSlots(["2026-08-06:20"], now, 3);
    expect(offered.filter((slot) => slot.startsWith("2026-08-06:"))).toEqual(["2026-08-06:20"]);
    expect(offered.some((slot) => slot.startsWith("2026-08-04:"))).toBe(true);
  });
});

describe("shouldOfferDefaultTourGrid", () => {
  it("offers the default when nothing future is published", () => {
    expect(shouldOfferDefaultTourGrid([])).toBe(true);
  });

  it("stands aside the moment one future slot is published", () => {
    expect(shouldOfferDefaultTourGrid(["2099-08-06:20"])).toBe(false);
  });
});

/** `withProcessTimeZone` for a body that returns a value. */
function withReturn<T>(timeZone: string, body: () => T): T | undefined {
  let out: T | undefined;
  withProcessTimeZone(timeZone, () => {
    out = body();
  });
  return out;
}

beforeEach(() => {
  process.env.TZ = originalTz;
});

afterEach(() => {
  process.env.TZ = originalTz;
});
