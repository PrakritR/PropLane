/**
 * The manager Calendar's time-grid math (studio-redesign-0929):
 * C2-CALP2 lanes + the 8 am to 7 pm fit, C2-CALP1 range label, C2-CALA4 drag
 * snap, C2-CALA6 which bands a tab draws and how a type is painted.
 */
import { describe, expect, it } from "vitest";
import {
  GRID_DEFAULT_FROM,
  GRID_HOUR_PX,
  GRID_DEFAULT_TO,
  bandKindsLabel,
  bandPaint,
  bandsForTab,
  bandStyle,
  calendarItemKind,
  calendarRangeLabel,
  fitGridWindow,
  formatClock,
  formatClockRange,
  layoutDayEvents,
  legendKinds,
  minutesAtOffset,
  openRunsSummary,
  runsFromStartMinutes,
  snapDragRange,
  type GridOpenRun,
} from "@/lib/calendar-grid";
import { AVAILABILITY_KINDS } from "@/lib/manager-availability-kinds";

describe("clock labels", () => {
  it("prints whole hours bare and half hours with minutes", () => {
    expect(formatClock(8 * 60)).toBe("8 am");
    expect(formatClock(12 * 60 + 30)).toBe("12:30 pm");
    expect(formatClock(0)).toBe("12 am");
    expect(formatClock(24 * 60)).toBe("12 am");
  });

  it("drops a repeated meridiem in a range", () => {
    expect(formatClockRange(10 * 60, 11 * 60 + 30)).toBe("10 – 11:30 am");
    expect(formatClockRange(11 * 60, 13 * 60)).toBe("11 am – 1 pm");
  });
});

describe("calendarItemKind", () => {
  it("colours by type: tours blue, services orange, tasks green (inspections are tasks)", () => {
    expect(calendarItemKind({ kind: "tour" })).toBe("tour");
    expect(calendarItemKind({ kind: "partner" })).toBe("tour");
    expect(calendarItemKind({ kind: "service" })).toBe("service");
    expect(calendarItemKind({ kind: "task", title: "Renew umbrella insurance" })).toBe("task");
    expect(calendarItemKind({ kind: "task", title: "Move-in inspection · Alder House" })).toBe("task");
    expect(calendarItemKind({ kind: "task", title: "Move-out · Maple Duplex" })).toBe("task");
  });

  it("draws Google busy time as its own neutral type", () => {
    expect(calendarItemKind({ googleCalendarPrivate: true })).toBe("busy");
  });
});

describe("layoutDayEvents (C2-CALP2)", () => {
  it("puts overlapping blocks side by side and gives a lone block the full width", () => {
    const placed = layoutDayEvents(
      [
        { id: "a", startMin: 10 * 60, durationMin: 60 },
        { id: "b", startMin: 10 * 60 + 30, durationMin: 60 },
        { id: "c", startMin: 14 * 60, durationMin: 30 },
      ],
      GRID_DEFAULT_FROM,
      GRID_DEFAULT_TO,
    );
    const byId = Object.fromEntries(placed.map((p) => [p.id, p]));
    expect(byId.a).toMatchObject({ lane: 0, lanes: 2 });
    expect(byId.b).toMatchObject({ lane: 1, lanes: 2 });
    expect(byId.c).toMatchObject({ lane: 0, lanes: 1 });
  });

  it("counts a short block as at least its drawn height so a neighbour cannot hide under it", () => {
    const placed = layoutDayEvents(
      [
        { id: "a", startMin: 11 * 60, durationMin: 30 },
        { id: "b", startMin: 11 * 60 + 40, durationMin: 30 },
      ],
      GRID_DEFAULT_FROM,
      GRID_DEFAULT_TO,
    );
    // 30 minutes draws 50 px = 50 minutes tall, so the 11:40 block overlaps it.
    expect(placed.every((p) => p.lanes === 2)).toBe(true);
  });

  it("leaves out blocks outside the window", () => {
    const placed = layoutDayEvents([{ id: "late", startMin: 21 * 60, durationMin: 60 }], GRID_DEFAULT_FROM, GRID_DEFAULT_TO);
    expect(placed).toEqual([]);
  });
});

describe("fitGridWindow (C2-CALP2)", () => {
  it("is 8 am to 7 pm and shows no earlier / later row when everything fits", () => {
    const win = fitGridWindow([{ startMin: 9 * 60, durationMin: 60 }]);
    expect(win).toEqual({ from: 8 * 60, to: 19 * 60, early: 0, late: 0 });
  });

  it("counts what falls outside and only widens when asked", () => {
    const items = [
      { startMin: 6 * 60 + 30, durationMin: 30 },
      { startMin: 20 * 60, durationMin: 60 },
      { startMin: 21 * 60, durationMin: 30 },
    ];
    const closed = fitGridWindow(items);
    expect(closed).toMatchObject({ from: 480, to: 1140, early: 1, late: 2 });
    const open = fitGridWindow(items, { early: true, late: true });
    expect(open.from).toBe(6 * 60);
    expect(open.to).toBe(22 * 60);
  });
});

describe("drag to add (C2-CALA4)", () => {
  it("snaps both ends to half hours, in either drag direction", () => {
    expect(snapDragRange(10 * 60 + 7, 11 * 60 + 20, 19 * 60)).toEqual({ from: 600, to: 690 });
    expect(snapDragRange(11 * 60 + 20, 10 * 60 + 7, 19 * 60)).toEqual({ from: 600, to: 690 });
  });

  it("is one half hour for a press that never moved, and never runs past the grid", () => {
    expect(snapDragRange(9 * 60 + 10, 9 * 60 + 10, 19 * 60)).toEqual({ from: 540, to: 570 });
    expect(snapDragRange(18 * 60 + 50, 18 * 60 + 50, 19 * 60)).toEqual({ from: 1110, to: 1140 });
  });

  it("maps a pointer offset to minutes inside the visible hours", () => {
    expect(minutesAtOffset(0, 480, 1140)).toBe(480);
    expect(minutesAtOffset(GRID_HOUR_PX, 480, 1140)).toBe(540);
    expect(minutesAtOffset(100000, 480, 1140)).toBe(1139);
    expect(minutesAtOffset(-50, 480, 1140)).toBe(480);
  });
});

const run = (startSlot: number, endSlotExclusive: number, kinds: GridOpenRun["kinds"], isDefault = false): GridOpenRun => ({
  startSlot,
  endSlotExclusive,
  kinds,
  isDefault,
});

describe("bandsForTab (C2-CALA6)", () => {
  const runs: GridOpenRun[] = [
    run(18, 34, ["tours"]),
    run(34, 38, ["services"]),
    run(38, 40, ["tours", "services", "tasks"]),
    run(10, 12, ["tours"], true),
  ];

  it("shows every band on All", () => {
    expect(bandsForTab(runs, "all")).toHaveLength(4);
  });

  it("shows only windows that include Tours on the Tours tab (Everything included, the default too)", () => {
    const bands = bandsForTab(runs, "tours");
    expect(bands.map((b) => b.startMin)).toEqual([300, 540, 1140]);
  });

  it("shows only windows with Services on the Services tab", () => {
    expect(bandsForTab(runs, "services").map((b) => b.startMin)).toEqual([1020, 1140]);
  });

  it("shows only windows with Tasks on the Tasks tab", () => {
    const bands = bandsForTab(runs, "tasks");
    expect(bands).toHaveLength(1);
    expect(bands[0]).toMatchObject({ startMin: 1140, endMin: 1200, source: "typed" });
  });

  it("marks the implicit default so the grid does not make it clickable", () => {
    expect(bandsForTab(runs, "all").find((b) => b.startMin === 300)?.source).toBe("default");
  });
});

describe("band paint and names (C2-CALA6)", () => {
  it("draws Everything as the plain hatch with no stripe", () => {
    expect(bandPaint(AVAILABILITY_KINDS)).toEqual({ plain: true, stripes: [] });
    expect(bandKindsLabel(AVAILABILITY_KINDS)).toBe("Tours, Services, Tasks");
    expect(bandStyle(bandPaint(AVAILABILITY_KINDS)).boxShadow).toBeUndefined();
  });

  it("draws a type with a stripe in its tab-dot colour and one stripe per type", () => {
    const one = bandPaint(["tours"]);
    expect(one.plain).toBe(false);
    expect(one.stripes).toEqual([{ kind: "tours", color: "#2a78d6" }]);
    const two = bandPaint(["services", "tasks"]);
    expect(two.stripes.map((s) => s.color)).toEqual(["#eb6834", "#1baf7a"]);
    expect(bandStyle(two).boxShadow).toBe("inset 3px 0 0 #eb6834, inset 6px 0 0 #1baf7a");
  });

  it("names the types on screen for the legend, once each", () => {
    const bands = bandsForTab([run(18, 20, ["tours"]), run(20, 22, ["tours"]), run(22, 24, ["services", "tasks"])], "all");
    expect(legendKinds(bands)).toEqual(["Tours", "Services, Tasks"]);
  });
});

describe("open time summary (C2-CALP4)", () => {
  it("merges half-hour starts into runs", () => {
    expect(runsFromStartMinutes([540, 570, 600, 780, 810])).toEqual([
      { from: 540, to: 630 },
      { from: 780, to: 840 },
    ]);
  });

  it("reads '9 am – 5 pm · 8 h'", () => {
    const starts = Array.from({ length: 16 }, (_, i) => 540 + i * 30);
    expect(openRunsSummary(starts)).toBe("9 am – 5 pm · 8 h");
    expect(openRunsSummary([])).toBe("");
  });
});

describe("calendarRangeLabel (C2-CALP1, CALP7)", () => {
  const week = { view: "week" as const, start: "2026-09-21", last: "2026-09-27", currentYear: 2026 };

  it("reads 'Sep 21 - Sep 27' with no year inside the current year", () => {
    expect(calendarRangeLabel(week)).toBe("Sep 21 - Sep 27");
  });

  it("is 'Sep 21 - 27' on a phone within one month", () => {
    expect(calendarRangeLabel({ ...week, phone: true })).toBe("Sep 21 - 27");
    expect(calendarRangeLabel({ ...week, start: "2026-09-28", last: "2026-10-04", phone: true })).toBe("Sep 28 - Oct 4");
  });

  it("adds the year only when it is another year or the week crosses one", () => {
    expect(calendarRangeLabel({ ...week, start: "2026-12-28", last: "2027-01-03" })).toBe("Dec 28 - Jan 3, 2027");
    expect(calendarRangeLabel({ ...week, currentYear: 2025 })).toBe("Sep 21 - Sep 27, 2026");
  });

  it("reads a month and a day", () => {
    expect(calendarRangeLabel({ view: "month", start: "2026-10-01", last: "2026-10-31", currentYear: 2026 })).toBe("October 2026");
    expect(calendarRangeLabel({ view: "day", start: "2026-10-05", last: "2026-10-05", currentYear: 2026 })).toBe("Mon, Oct 5");
  });
});
