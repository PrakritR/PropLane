import { describe, expect, it } from "vitest";
import { dayLabel } from "@/components/portal/pro-dashboard-kpis";

/**
 * C240: the Upcoming panel used `Date.prototype.getHours` / `toLocaleTimeString`
 * with no `timeZone`, so a tour's displayed time depended on the SERVER
 * process's local clock rather than the workspace's Pacific one — a 10:00 AM
 * Pacific tour could render as an implausible early-morning hour. `dayLabel`
 * now formats through `pacific-time.ts`, so this must hold regardless of the
 * test runner's own TZ.
 */
describe("dashboard Upcoming panel reads times in Pacific, not process-local, time", () => {
  it("shows a late-morning Pacific tour as late morning, not early morning", () => {
    // 2026-06-15T17:00:00Z = 2026-06-15 10:00 AM PDT (UTC-7).
    const tourMs = Date.parse("2026-06-15T17:00:00Z");
    const nowMs = Date.parse("2026-06-15T15:00:00Z"); // same Pacific calendar day, 8:00 AM PDT
    const { day, time } = dayLabel(tourMs, nowMs);
    expect(day).toBe("Today");
    expect(time).toBe("10:00 AM");
  });

  it("does not slip a late-evening Pacific tour into the next calendar day", () => {
    // 2026-06-16T06:30:00Z = 2026-06-15 11:30 PM PDT — still "today" in Pacific
    // even though the UTC calendar date has already rolled to the 16th.
    const tourMs = Date.parse("2026-06-16T06:30:00Z");
    const nowMs = Date.parse("2026-06-15T15:00:00Z");
    const { day, time } = dayLabel(tourMs, nowMs);
    expect(day).toBe("Today");
    expect(time).toBe("11:30 PM");
  });

  it("labels a midnight-exact timestamp as having no time (all day)", () => {
    // 2026-06-15T07:00:00Z = 2026-06-15 00:00 (midnight) PDT.
    const ms = Date.parse("2026-06-15T07:00:00Z");
    const nowMs = ms;
    const { time } = dayLabel(ms, nowMs);
    expect(time).toBe("");
  });
});
