/**
 * A booking's check-in anchor is PACIFIC wall time.
 *
 * Stays carry a bare `YYYY-MM-DD`. `new Date("2026-09-18")` parses as UTC
 * midnight, which in Pacific is the afternoon of the 17th — so a "1 day before
 * check-in" reminder computed that way lands a day early on Vercel and on time
 * on a developer's Pacific laptop. That asymmetry is why this is pinned.
 */
import { describe, expect, it } from "vitest";
import { bookingCheckInIso } from "@/lib/reminders/subjects/bookings.server";

function pacificParts(iso: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(new Date(iso));
}

function pacific(iso: string, type: string): string {
  return pacificParts(iso).find((p) => p.type === type)!.value;
}

describe("booking check-in anchor", () => {
  it("lands at 3pm Pacific on the check-in DATE, in summer (PDT)", () => {
    const iso = bookingCheckInIso("2026-09-18")!;
    expect(iso).not.toBeNull();
    expect(pacific(iso, "day")).toBe("18");
    expect(pacific(iso, "month")).toBe("09");
    expect(Number(pacific(iso, "hour"))).toBe(15);
    // PDT is UTC-7, so 3pm local is 22:00Z. A naive parse would give 00:00Z.
    expect(iso).toBe("2026-09-18T22:00:00.000Z");
  });

  it("still lands at 3pm Pacific in winter (PST), a different UTC offset", () => {
    const iso = bookingCheckInIso("2027-01-14")!;
    expect(pacific(iso, "day")).toBe("14");
    expect(Number(pacific(iso, "hour"))).toBe(15);
    expect(iso).toBe("2027-01-14T23:00:00.000Z");
  });

  it("holds across the spring-forward day", () => {
    const iso = bookingCheckInIso("2027-03-14")!;
    expect(pacific(iso, "day")).toBe("14");
    expect(Number(pacific(iso, "hour"))).toBe(15);
  });

  it("refuses anything that is not a plain date key", () => {
    expect(bookingCheckInIso("")).toBeNull();
    expect(bookingCheckInIso("not-a-date")).toBeNull();
    expect(bookingCheckInIso("2026-9-8")).toBeNull();
    expect(bookingCheckInIso("2026-09-18T10:00:00Z")).toBeNull();
  });
});
