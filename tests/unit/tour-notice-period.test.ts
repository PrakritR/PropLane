/**
 * A manager's required notice before a tour.
 *
 * "Three days' notice" means three CALENDAR days, not 72 hours — a manager who books at 9am and
 * one who books at 11pm on the same day must be offered the same first day, or the setting is
 * unpredictable. The shift is therefore done on the Pacific calendar date, which also keeps it
 * correct across DST, where a day is 23 or 25 hours and instant arithmetic lands a day out.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TOUR_NOTICE_DAYS,
  earliestBookableTourDate,
  normalizeTourNoticeDays,
  slotIsBookable,
} from "@/lib/tour-slot-math";

// 2026-08-24 10:00 Pacific (PDT, UTC-7).
const MON_10AM = Date.parse("2026-08-24T17:00:00Z");
// Same Pacific day, late evening — must not shift the answer.
const MON_11PM = Date.parse("2026-08-25T06:00:00Z");

describe("earliestBookableTourDate", () => {
  it("is today when the manager requires no notice", () => {
    expect(earliestBookableTourDate(0, MON_10AM)).toBe("2026-08-24");
  });

  it("counts whole calendar days forward", () => {
    expect(earliestBookableTourDate(1, MON_10AM)).toBe("2026-08-25");
    expect(earliestBookableTourDate(2, MON_10AM)).toBe("2026-08-26");
    expect(earliestBookableTourDate(3, MON_10AM)).toBe("2026-08-27");
  });

  it("gives the same answer whatever time of day it is asked", () => {
    // The 72-hour reading would put these three days apart from each other.
    expect(earliestBookableTourDate(3, MON_11PM)).toBe(earliestBookableTourDate(3, MON_10AM));
  });

  it("rolls over month and year boundaries", () => {
    const dec30 = Date.parse("2026-12-30T18:00:00Z"); // 10:00 Pacific
    expect(earliestBookableTourDate(3, dec30)).toBe("2027-01-02");
  });

  it("crosses a DST fall-back without losing a day", () => {
    // Nov 1 2026 is the PDT→PST transition (a 25-hour day). Adding 86_400_000ms three times
    // would land on Nov 3, not Nov 4.
    const oct31 = Date.parse("2026-10-31T17:00:00Z"); // 10:00 PDT
    expect(earliestBookableTourDate(4, oct31)).toBe("2026-11-04");
  });
});

describe("normalizeTourNoticeDays", () => {
  it("defaults to no notice for junk", () => {
    for (const raw of [null, undefined, "abc", NaN, {}]) {
      expect(normalizeTourNoticeDays(raw)).toBe(DEFAULT_TOUR_NOTICE_DAYS);
    }
  });

  it("treats negatives as no notice", () => {
    expect(normalizeTourNoticeDays(-5)).toBe(0);
  });

  it("caps rather than zeroes an out-of-range value", () => {
    // Reading "9999 days" as zero would silently open same-day tours a manager disallowed —
    // the wrong direction to be wrong in.
    expect(normalizeTourNoticeDays(9999)).toBe(30);
  });

  it("floors a fractional value", () => {
    expect(normalizeTourNoticeDays(2.9)).toBe(2);
  });
});

describe("slotIsBookable with a notice period", () => {
  const at = (date: string, slot: number) => `${date}:${slot}`;

  it("still refuses a slot in the past", () => {
    expect(slotIsBookable(at("2026-08-24", 10), MON_10AM, 0)).toBe(false);
  });

  it("allows same-day when no notice is required", () => {
    // 4pm today, booked at 10am.
    expect(slotIsBookable(at("2026-08-24", 32), MON_10AM, 0)).toBe(true);
  });

  it("refuses same-day and tomorrow when three days' notice is required", () => {
    expect(slotIsBookable(at("2026-08-24", 32), MON_10AM, 3)).toBe(false);
    expect(slotIsBookable(at("2026-08-25", 20), MON_10AM, 3)).toBe(false);
    expect(slotIsBookable(at("2026-08-26", 20), MON_10AM, 3)).toBe(false);
  });

  it("allows the first day past the notice period, from its first slot", () => {
    // The boundary day is fully open — notice is counted in days, so an early slot on the
    // third day is not "not quite 72 hours" and refused.
    expect(slotIsBookable(at("2026-08-27", 0), MON_10AM, 3)).toBe(true);
    expect(slotIsBookable(at("2026-08-28", 20), MON_10AM, 3)).toBe(true);
  });

  it("defaults to no notice, so existing callers are unaffected", () => {
    expect(slotIsBookable(at("2026-08-24", 32), MON_10AM)).toBe(true);
  });

  it("rejects a malformed slot key rather than guessing", () => {
    expect(slotIsBookable("not-a-slot", MON_10AM, 3)).toBe(false);
    expect(slotIsBookable("", MON_10AM, 3)).toBe(false);
  });
});
