/**
 * The header's tab counts follow the range the view shows (C2-CALP1): a Month
 * view's "Tours 6" is the month's tours, a Day view's is that day's.
 */
import { describe, expect, it } from "vitest";
import type { DemoMeeting } from "@/components/portal/portal-calendar-panels";
import { meetingsInRange } from "@/lib/manager-calendar-tour-meetings";

const m = (dateStr: string): DemoMeeting =>
  ({ id: dateStr, dateStr, kind: "tour" }) as unknown as DemoMeeting;

const meetings = [m("2026-09-28"), m("2026-09-30"), m("2026-10-04"), m("2026-10-05"), m("2026-10-20"), m("2026-11-02")];
const anchor = new Date(2026, 9, 1, 12); // Thu Oct 1 2026, week Sep 28 - Oct 4

describe("meetingsInRange", () => {
  it("counts the day", () => {
    expect(meetingsInRange(meetings, new Date(2026, 9, 5, 12), "day").map((x) => x.dateStr)).toEqual(["2026-10-05"]);
  });

  it("counts the Monday-Sunday week for Week and Agenda", () => {
    const week = ["2026-09-28", "2026-09-30", "2026-10-04"];
    expect(meetingsInRange(meetings, anchor, "week").map((x) => x.dateStr)).toEqual(week);
    expect(meetingsInRange(meetings, anchor, "agenda").map((x) => x.dateStr)).toEqual(week);
  });

  it("counts the calendar month", () => {
    expect(meetingsInRange(meetings, anchor, "month").map((x) => x.dateStr)).toEqual([
      "2026-10-04",
      "2026-10-05",
      "2026-10-20",
    ]);
  });
});
