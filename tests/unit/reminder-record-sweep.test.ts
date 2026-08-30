/**
 * Anchor parsing for the record-backed subjects.
 *
 * Work orders and add-on services keep their anchor inside `row_data`, and both
 * use sentinel strings for "not set" — an em dash for an unscheduled visit, an
 * empty string for a service with no deposit. Reading either as a date is how a
 * reminder ends up scheduled against nothing.
 */
import { describe, expect, it } from "vitest";
import { isoOrNull, withinHorizon } from "@/lib/reminders/subjects/records.server";

const NOW = new Date("2026-08-30T12:00:00.000Z");
const inHours = (h: number) => new Date(NOW.getTime() + h * 3600_000).toISOString();

describe("isoOrNull", () => {
  it("normalizes a real timestamp", () => {
    expect(isoOrNull("2026-08-30T14:00:00Z")).toBe("2026-08-30T14:00:00.000Z");
  });

  it("treats the display placeholders as unset, not as a bad date", () => {
    // These are what the records actually store for "no date".
    expect(isoOrNull("—")).toBeNull();
    expect(isoOrNull("")).toBeNull();
    expect(isoOrNull("   ")).toBeNull();
  });

  it("rejects anything that is not a date", () => {
    expect(isoOrNull("soon")).toBeNull();
    expect(isoOrNull(null)).toBeNull();
    expect(isoOrNull(undefined)).toBeNull();
    expect(isoOrNull(1234)).toBeNull();
    expect(isoOrNull({})).toBeNull();
  });
});

describe("withinHorizon", () => {
  it("accepts an anchor ahead of now and inside the window", () => {
    expect(withinHorizon(inHours(2), NOW)).toBe(true);
    expect(withinHorizon(inHours(24 * 30), NOW)).toBe(true);
  });

  it("rejects an anchor already past — reminding after the fact is not a reminder", () => {
    expect(withinHorizon(inHours(-1), NOW)).toBe(false);
    expect(withinHorizon(NOW.toISOString(), NOW)).toBe(false);
  });

  it("rejects an anchor beyond the horizon so a sweep stays bounded", () => {
    expect(withinHorizon(inHours(24 * 40), NOW)).toBe(false);
  });

  it("rejects a missing or unparseable anchor", () => {
    expect(withinHorizon(null, NOW)).toBe(false);
    expect(withinHorizon("nonsense", NOW)).toBe(false);
  });
});
