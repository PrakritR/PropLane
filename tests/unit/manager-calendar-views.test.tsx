// @vitest-environment jsdom
//
// The manager Calendar's views (studio-redesign-0929): Week/Day grid blocks and
// hatched bands (C2-CALP2/3), drag to add (C2-CALA4), click a band (C2-CALA5),
// Month (C2-CALP5), Agenda (C2-CALP5), the Day panel's chips (C2-CALP4) and the
// empty-week line (C2-CALP6).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { DemoMeeting } from "@/components/portal/portal-calendar-panels";
import {
  CalendarAgendaView,
  CalendarBandLegend,
  CalendarDayPanel,
  CalendarEmptyStrip,
  CalendarMonthView,
  CalendarTimeGrid,
  meetingToGridItems,
  type CalendarGridItem,
} from "@/components/portal/manager-calendar-views";
import { GRID_HOUR_PX, bandsForTab, fitGridWindow, type GridBand } from "@/lib/calendar-grid";

/** Pointer offsets below were written for 60 px hours; scale them to the real hour height. */
const yAt = (px60: number) => Math.round((px60 * GRID_HOUR_PX) / 60);

afterEach(cleanup);

const WEEK = ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27"];

function meeting(partial: Partial<DemoMeeting> & { id: string; startIso: string; dateStr: string }): DemoMeeting {
  const start = new Date(partial.startIso);
  return {
    source: "planned",
    sourceId: partial.id,
    endIso: new Date(start.getTime() + (partial.durationMinutes ?? 30) * 60000).toISOString(),
    startSlot: start.getHours() * 2 + (start.getMinutes() >= 30 ? 1 : 0),
    span: 1,
    durationMinutes: 30,
    title: "Tour · Casey Reyes",
    color: "",
    propertyTitle: "Alder House",
    kind: "tour",
    ...partial,
  };
}

const tour = meeting({ id: "t1", startIso: "2026-09-26T10:00:00", dateStr: "2026-09-26" });
const service = meeting({
  id: "s1",
  startIso: "2026-09-25T13:00:00",
  dateStr: "2026-09-25",
  kind: "service",
  title: "Vendor visit — Closet door",
  durationMinutes: 90,
  source: "external",
});
const task = meeting({
  id: "k1",
  startIso: "2026-09-26T09:00:00",
  dateStr: "2026-09-26",
  kind: "task",
  title: "Post September rent notice",
  allDay: true,
});

function items(...list: DemoMeeting[]): CalendarGridItem[] {
  return list.flatMap(meetingToGridItems);
}

const noop = () => {};

function renderGrid(over: Partial<React.ComponentProps<typeof CalendarTimeGrid>> = {}) {
  const grid = items(tour, service, task);
  const bands = new Map<string, GridBand[]>();
  for (const ds of WEEK) {
    bands.set(
      ds,
      ds === "2026-09-22"
        ? bandsForTab([{ startSlot: 18, endSlotExclusive: 34, kinds: ["tours"] }], "all")
        : bandsForTab([{ startSlot: 18, endSlotExclusive: 34, kinds: ["tours"], isDefault: true }], "all"),
    );
  }
  return render(
    <CalendarTimeGrid
      dates={WEEK}
      items={grid}
      bandsByDate={bands}
      window={fitGridWindow(grid.filter((i) => !i.allDay))}
      expandEarly={false}
      expandLate={false}
      onToggleEarly={noop}
      onToggleLate={noop}
      todayDs="2026-09-24"
      nowMin={15 * 60}
      isDay={false}
      canEditAvailability
      onOpenItem={noop}
      onBandClick={noop}
      onDragAdd={noop}
      {...over}
    />,
  );
}

describe("meetingToGridItems", () => {
  it("splits a multi-day event into one block per day and keeps an all-day task in the all-day row", () => {
    const long = meeting({
      id: "g1",
      startIso: "2026-09-25T22:00:00",
      dateStr: "2026-09-25",
      durationMinutes: 240,
      kind: "service",
    });
    const parts = meetingToGridItems(long);
    expect(parts.map((p) => [p.dateStr, p.startMin, p.durationMin])).toEqual([
      ["2026-09-25", 22 * 60, 120],
      ["2026-09-26", 0, 120],
    ]);
    expect(meetingToGridItems(task)[0]).toMatchObject({ allDay: true, kind: "task" });
  });

  it("marks a request still waiting on the manager", () => {
    expect(meetingToGridItems(meeting({ id: "r", startIso: "2026-09-26T10:00:00", dateStr: "2026-09-26", source: "inquiry" }))[0]!.requested).toBe(true);
  });
});

describe("CalendarTimeGrid", () => {
  it("draws type-coloured blocks with time, title and house, and a red now-line only in today's column", () => {
    renderGrid();
    const blocks = document.querySelectorAll('[data-attr="calendar-event-block"]');
    expect(blocks).toHaveLength(2);
    const kinds = [...blocks].map((b) => b.getAttribute("data-cal-kind")).sort();
    expect(kinds).toEqual(["service", "tour"]);
    const tourBlock = [...blocks].find((b) => b.getAttribute("data-cal-kind") === "tour")!;
    expect(tourBlock.textContent).toContain("10 am");
    expect(tourBlock.textContent).toContain("Tour · Casey Reyes");
    expect(tourBlock.textContent).toContain("Alder House");
    expect(document.querySelectorAll('[data-attr="calendar-now-line"]')).toHaveLength(1);
    const col = document.querySelector('[data-day="2026-09-24"]')!;
    expect(col.querySelector('[data-attr="calendar-now-line"]')).toBeTruthy();
    const todayHeader = document.querySelector('[data-attr="calendar-day-header"][data-date="2026-09-24"] span')!;
    expect(todayHeader.className).toContain("text-primary");
  });

  it("keeps a due-date task in the All day row, still openable", () => {
    const onOpenItem = vi.fn();
    renderGrid({ onOpenItem });
    const row = document.querySelector('[data-attr="calendar-all-day-row"]')!;
    const chip = within(row as HTMLElement).getByText("Post September rent notice");
    fireEvent.click(chip);
    expect(onOpenItem).toHaveBeenCalledTimes(1);
    expect(onOpenItem.mock.calls[0]![0]).toMatchObject({ kind: "task" });
  });

  it("opens a record from a block", () => {
    const onOpenItem = vi.fn();
    renderGrid({ onOpenItem });
    fireEvent.click(document.querySelector('[data-cal-kind="tour"][data-attr="calendar-event-block"]')!);
    expect(onOpenItem.mock.calls[0]![0].meeting.id).toBe("t1");
  });

  it("day headers carry the weekday and date only, with no open/booked counts", () => {
    renderGrid();
    const header = document.querySelector('[data-attr="calendar-day-header"][data-date="2026-09-24"]')!;
    expect(header.textContent).toBe("Thu 24");
    expect(document.body.textContent).not.toMatch(/\d+ open|booked/i);
  });

  it("labels the gutter with hours only", () => {
    renderGrid();
    expect(document.body.textContent).toContain("8 am");
    expect(document.body.textContent).toContain("6 pm");
    expect(document.body.textContent).not.toContain("8:30 am");
  });

  it("only a painted band is clickable; the implicit 9 to 5 default never opens anything (C2-CALA5)", () => {
    const onBandClick = vi.fn();
    renderGrid({ onBandClick });
    const typed = document.querySelector('[data-attr="calendar-open-band"][data-band-source="typed"]')!;
    const dflt = document.querySelector('[data-attr="calendar-open-band"][data-band-source="default"]')!;
    fireEvent.click(dflt);
    expect(onBandClick).not.toHaveBeenCalled();
    fireEvent.click(typed);
    expect(onBandClick).toHaveBeenCalledTimes(1);
    expect(onBandClick.mock.calls[0]![0]).toBe("2026-09-22");
    expect(typed.getAttribute("title")).toContain("click to edit");
  });

  it("names a typed band by its type and keeps the default unlabelled in the week", () => {
    renderGrid();
    const typed = document.querySelector('[data-band-source="typed"]')!;
    expect(typed.textContent).toBe("Tours");
  });

  it("shows a quiet 'N item earlier' row only when something falls outside, and toggles it", () => {
    const early = items(meeting({ id: "e1", startIso: "2026-09-23T06:30:00", dateStr: "2026-09-23" }));
    const onToggleEarly = vi.fn();
    renderGrid({ items: early, window: fitGridWindow(early), onToggleEarly });
    const row = screen.getByText("1 item earlier");
    fireEvent.click(row);
    expect(onToggleEarly).toHaveBeenCalled();
    expect(screen.queryByText(/later/)).toBeNull();
  });

  it("makes no band, drag or click affordance when availability can't be edited", () => {
    const onBandClick = vi.fn();
    renderGrid({ canEditAvailability: false, onBandClick });
    const typed = document.querySelector('[data-band-source="typed"]')!;
    fireEvent.click(typed);
    expect(onBandClick).not.toHaveBeenCalled();
    expect(typed.getAttribute("role")).toBeNull();
  });

  describe("drag to add (C2-CALA4)", () => {
    function drag(col: Element, from: number, to: number) {
      fireEvent.pointerDown(col, { button: 0, pointerType: "mouse", pointerId: 1, clientY: from, clientX: 10 });
      fireEvent.pointerMove(window, { pointerType: "mouse", pointerId: 1, clientY: to, clientX: 10 });
    }

    it("snaps to half hours, shows the time, and opens Add availability on release", () => {
      const onDragAdd = vi.fn();
      renderGrid({ onDragAdd });
      const col = document.querySelector('[data-day="2026-09-23"]')!;
      // Window starts at 8 am; offsets scaled from 60 px per hour. 130 px = 10:10 (the 10 am half hour);
      // 245 px = 12:05 (the 12 pm half hour) — so the band covers 10 am to 12:30 pm.
      drag(col, yAt(130), yAt(245));
      const ghost = document.querySelector('[data-attr="calendar-drag-ghost"]');
      expect(ghost?.textContent).toBe("10 am – 12:30 pm");
      fireEvent.pointerUp(window, { pointerType: "mouse", pointerId: 1, clientY: yAt(245) });
      expect(onDragAdd).toHaveBeenCalledWith("2026-09-23", 10 * 60, 12 * 60 + 30);
      expect(document.querySelector('[data-attr="calendar-drag-ghost"]')).toBeNull();
    });

    it("does nothing for a click that never moved, and a click on a block never starts one", () => {
      const onDragAdd = vi.fn();
      renderGrid({ onDragAdd });
      const col = document.querySelector('[data-day="2026-09-23"]')!;
      fireEvent.pointerDown(col, { button: 0, pointerType: "mouse", pointerId: 1, clientY: yAt(100), clientX: 10 });
      fireEvent.pointerUp(window, { pointerType: "mouse", pointerId: 1, clientY: yAt(100) });
      expect(onDragAdd).not.toHaveBeenCalled();
      const block = document.querySelector('[data-attr="calendar-event-block"]')!;
      fireEvent.pointerDown(block, { button: 0, pointerType: "mouse", pointerId: 2, clientY: yAt(100), clientX: 10 });
      fireEvent.pointerMove(window, { pointerType: "mouse", pointerId: 2, clientY: yAt(200) });
      fireEvent.pointerUp(window, { pointerType: "mouse", pointerId: 2, clientY: yAt(200) });
      expect(onDragAdd).not.toHaveBeenCalled();
    });

    it("Escape cancels", () => {
      const onDragAdd = vi.fn();
      renderGrid({ onDragAdd });
      const col = document.querySelector('[data-day="2026-09-23"]')!;
      drag(col, yAt(130), yAt(245));
      fireEvent.keyDown(window, { key: "Escape" });
      fireEvent.pointerUp(window, { pointerType: "mouse", pointerId: 1, clientY: yAt(245) });
      expect(onDragAdd).not.toHaveBeenCalled();
    });

    it("is off when availability can't be edited", () => {
      const onDragAdd = vi.fn();
      renderGrid({ onDragAdd, canEditAvailability: false });
      const col = document.querySelector('[data-day="2026-09-23"]')!;
      drag(col, yAt(130), yAt(245));
      fireEvent.pointerUp(window, { pointerType: "mouse", pointerId: 1, clientY: yAt(245) });
      expect(onDragAdd).not.toHaveBeenCalled();
    });
  });
});

describe("CalendarBandLegend (C2-CALA6)", () => {
  it("names the types on screen", () => {
    const bands = bandsForTab(
      [
        { startSlot: 18, endSlotExclusive: 20, kinds: ["tours"] },
        { startSlot: 20, endSlotExclusive: 22, kinds: ["services", "tasks"] },
      ],
      "all",
    );
    render(<CalendarBandLegend bands={bands} tab="all" />);
    const legend = screen.getByText("Open for").parentElement!;
    expect(legend.textContent).toBe("Open forToursServices, Tasks");
  });

  it("says what the plain hatch means when nothing is painted", () => {
    render(<CalendarBandLegend bands={[]} tab="tours" />);
    expect(screen.getByText("Open for tours")).toBeTruthy();
  });
});

describe("CalendarEmptyStrip (C2-CALP6)", () => {
  it("is one line with a jump to the nearest item", () => {
    const onJump = vi.fn();
    render(
      <CalendarEmptyStrip
        label="Nothing scheduled this week"
        jump={{ text: "Next: Renew umbrella insurance · Mon, Oct 5", dateStr: "2026-10-05" }}
        onJump={onJump}
        addMenu={<button type="button">add</button>}
      />,
    );
    expect(screen.getByText("Nothing scheduled this week")).toBeTruthy();
    fireEvent.click(screen.getByText("Next: Renew umbrella insurance · Mon, Oct 5"));
    expect(onJump).toHaveBeenCalledWith("2026-10-05");
    // The header + is the calendar's only create action; the strip never draws a second one.
    expect(screen.queryByText("add")).toBeNull();
  });
});

describe("CalendarMonthView (C2-CALP5)", () => {
  const many = [1, 2, 3, 4].map((n) =>
    meeting({ id: `m${n}`, startIso: `2026-10-05T${String(n + 7).padStart(2, "0")}:00:00`, dateStr: "2026-10-05", title: `Tour ${n}` }),
  );

  it("is Monday first, shows three chips and '+N more', and a day number opens that Day", () => {
    const onOpenDay = vi.fn();
    render(
      <CalendarMonthView
        monthStart="2026-10-01"
        items={items(...many)}
        todayDs="2026-10-03"
        phone={false}
        openHalfHoursFor={(ds) => (ds === "2026-10-06" ? 16 : 0)}
        openLabel="Open hours"
        onOpenItem={noop}
        onOpenDay={onOpenDay}
      />,
    );
    const heads = document.querySelectorAll('[data-attr="calendar-month-view"] > div:nth-child(1) > div');
    expect([...heads].map((h) => h.textContent)).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    const cell = document.querySelector('[data-attr="calendar-month-day"][data-date="2026-10-05"]')!;
    expect(cell.querySelectorAll('[data-attr="calendar-month-chip"]')).toHaveLength(3);
    fireEvent.click(within(cell as HTMLElement).getByText("+1 more"));
    expect(onOpenDay).toHaveBeenCalledWith("2026-10-05");
    fireEvent.click(within(cell as HTMLElement).getByRole("button", { name: /Monday, Oct 5/ }));
    expect(onOpenDay).toHaveBeenCalledTimes(2);
    // A hatched strip where tours can be booked.
    expect(
      document.querySelector('[data-date="2026-10-06"] [data-attr="calendar-month-open"]')?.getAttribute("title"),
    ).toBe("8 h open");
    expect(document.querySelector('[data-date="2026-10-07"] [data-attr="calendar-month-open"]')).toBeNull();
  });

  it("draws dots instead of chips on a phone", () => {
    render(
      <CalendarMonthView
        monthStart="2026-10-01"
        items={items(...many)}
        todayDs="2026-10-03"
        phone
        openHalfHoursFor={() => 0}
        openLabel="Open hours"
        onOpenItem={noop}
        onOpenDay={noop}
      />,
    );
    expect(document.querySelectorAll('[data-attr="calendar-month-chip"]')).toHaveLength(0);
    expect(document.querySelectorAll('[data-attr="calendar-month-pip"]')).toHaveLength(3);
  });
});

describe("CalendarAgendaView (C2-CALP5)", () => {
  it("groups the week by day with date headers and offers Open and Reschedule on tours", async () => {
    const onRescheduleTour = vi.fn();
    render(
      <CalendarAgendaView
        dates={WEEK}
        items={items(tour, service, task)}
        todayDs="2026-09-24"
        onOpenItem={noop}
        onRescheduleTour={onRescheduleTour}
      />,
    );
    const headers = [...document.querySelectorAll('[data-attr="calendar-agenda-day-header"]')].map((h) => h.textContent);
    expect(headers[0]).toContain("Friday");
    expect(headers[1]).toContain("Saturday");
    expect(document.querySelectorAll('[data-attr="calendar-agenda-row"]')).toHaveLength(3);
    // exactly one ⋯ per row
    expect(document.querySelectorAll('[data-attr="calendar-agenda-row-menu"]')).toHaveLength(3);
  });

  it("shows the empty line instead of a blank list", () => {
    render(
      <CalendarAgendaView
        dates={WEEK}
        items={[]}
        todayDs="2026-09-24"
        emptyStrip={<CalendarEmptyStrip label="Nothing scheduled this week" />}
        onOpenItem={noop}
      />,
    );
    expect(screen.getByText("Nothing scheduled this week")).toBeTruthy();
  });
});

describe("CalendarDayPanel (C2-CALP4)", () => {
  const starts = Array.from({ length: 16 }, (_, i) => 540 + i * 30);

  it("lists the day, the open summary, and a chip that starts a booking with day and time filled in", () => {
    const onBookSlot = vi.fn();
    render(
      <CalendarDayPanel
        dateStr="2026-09-26"
        isToday={false}
        items={items(tour, task)}
        openStarts={starts}
        chipStarts={starts.slice(2)}
        openSummary="9 am – 5 pm · 8 h"
        canEditAvailability
        onOpenItem={noop}
        onBookSlot={onBookSlot}
        onAddAvailability={noop}
      />,
    );
    expect(screen.getByText("9 am – 5 pm · 8 h")).toBeTruthy();
    expect(document.querySelectorAll('[data-attr="calendar-day-agenda-item"]')).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Book a tour at 10 am" }));
    expect(onBookSlot).toHaveBeenCalledWith("2026-09-26", 600);
  });

  it("says there are no tour times and links to Add availability", () => {
    const onAdd = vi.fn();
    render(
      <CalendarDayPanel
        dateStr="2026-09-27"
        isToday={false}
        items={[]}
        openStarts={[]}
        chipStarts={[]}
        openSummary=""
        canEditAvailability
        onOpenItem={noop}
        onBookSlot={noop}
        onAddAvailability={onAdd}
      />,
    );
    expect(screen.getByText("No tour times on Sundays")).toBeTruthy();
    fireEvent.click(screen.getByText("Add availability"));
    expect(onAdd).toHaveBeenCalledWith("2026-09-27");
  });

  it("says when nothing is left today", () => {
    render(
      <CalendarDayPanel
        dateStr="2026-09-24"
        isToday
        items={[]}
        openStarts={starts}
        chipStarts={[]}
        openSummary="9 am – 5 pm · 8 h"
        canEditAvailability={false}
        onOpenItem={noop}
        onBookSlot={noop}
        onAddAvailability={noop}
      />,
    );
    expect(screen.getByText("No open times left today")).toBeTruthy();
    expect(screen.queryByText("Add availability")).toBeNull();
  });
});
