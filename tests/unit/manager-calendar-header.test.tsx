// @vitest-environment jsdom
//
// The Calendar header is one row (studio-redesign-0929 C2-CALP1/CALP2/CALP7):
// All / Tours / Services / Tasks tabs with counts (no dots), then
// Search, Filter, the clock and +; Day / Week / Month underline tabs and the
// range with its chevrons ride in a toolbar row above the grid.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { DestinationNav } from "@/components/ui/destination-nav";

vi.mock("next/navigation", () => ({
  usePathname: () => "/portal/calendar",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
}));

afterEach(cleanup);

const page = readFileSync(join(process.cwd(), "src/components/portal/portal-calendar.tsx"), "utf8");
const panels = readFileSync(join(process.cwd(), "src/components/portal/portal-calendar-panels.tsx"), "utf8");

describe("tab dots", () => {
  it("draws no colored dot on any calendar tab — the tabs are plain words and counts", () => {
    const { container } = render(
      <DestinationNav
        appearance="command"
        activeId="all"
        items={[
          { id: "all", label: "All", href: "/portal/calendar", count: 6 },
          { id: "tours", label: "Tours", href: "/portal/calendar/tours", count: 2 },
          { id: "services", label: "Services", href: "/portal/calendar/services", count: 1 },
          { id: "tasks", label: "Tasks", href: "/portal/calendar/tasks", count: 2 },
        ]}
      />,
    );
    expect(container.querySelectorAll('[data-slot="destination-nav-dot"]')).toHaveLength(0);
  });

  it("the page no longer hands the tabs a dot colour", () => {
    expect(page).not.toContain("dotColor");
    expect(page).not.toContain("CALENDAR_TAB_DOT_COLOR");
  });
});

describe("one header row", () => {
  it("orders the band Filter, the clock and +, then the toolbar row above the grid holds the view tabs and the range", () => {
    const filter = page.indexOf("{calendarFilterSheet}");
    const clock = page.indexOf('data-slot="calendar-week-actions-host"');
    const plus = page.indexOf('data-slot="calendar-primary-action-host"');
    expect(filter).toBeGreaterThan(0);
    expect(clock).toBeGreaterThan(filter);
    expect(plus).toBeGreaterThan(clock);
    expect(page).not.toContain('data-slot="calendar-nav-host"');
    const studio = panels.slice(panels.indexOf("if (studioActive) {"), panels.indexOf("if (compactAvailability) {"));
    const toolbar = studio.indexOf('data-attr="calendar-toolbar"');
    const range = studio.indexOf('data-attr="calendar-range-label"');
    expect(toolbar).toBeGreaterThan(0);
    expect(range).toBeGreaterThan(toolbar);
  });

  it("has no second control row: no 6 am - 10 pm pickers, no arrows, no Day/Week/Month pills", () => {
    const studio = panels.slice(panels.indexOf("if (studioActive) {"), panels.indexOf("if (compactAvailability) {"));
    expect(studio).toContain("<ChevronLeft");
    expect(studio).toContain("<ChevronRight");
    expect(studio).not.toContain("renderTimeWindowControl");
    expect(studio).not.toContain("PortalSegmentedControl");
    expect(studio).not.toContain("←");
    // Day / Week / Month are underline tabs (a picker on a phone), never a raw select.
    expect(studio).toContain("<LocalDestinationNav");
    expect(studio).toContain('ariaLabel="Calendar view"');
    expect(studio).not.toContain("<Select");
  });

  it("the clock menu is Add availability, Copy previous week, Clear week, Copy to houses (C2-CALA1)", () => {
    const studio = panels.slice(panels.indexOf("if (studioActive) {"), panels.indexOf("if (compactAvailability) {"));
    const order = ["Add availability", "Copy previous week", "Clear week", "Copy to houses"].map((l) => studio.indexOf(l));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(studio).not.toContain("Edit tour availability");
    expect(studio).not.toContain("Add availability block");
    expect(studio).toContain("icon={Clock}");
  });

  it("the + is the one create action: New tour, New task, New service", () => {
    const studio = panels.slice(panels.indexOf("if (studioActive) {"), panels.indexOf("if (compactAvailability) {"));
    for (const label of ["New tour", "New task", "New service"]) expect(studio).toContain(label);
  });

  it("a phone folds the view tabs into a picker and defaults to Agenda, remembered per device", () => {
    expect(panels).toContain("<LocalDestinationNav");
    const pref = readFileSync(join(process.cwd(), "src/lib/manager-calendar-view-preference.ts"), "utf8");
    expect(pref).toContain('return isPhone ? "agenda" : "week";');
    expect(pref).toContain("managerCalendarViewStorageKey(isPhone)");
  });
});

describe("Agenda (studio plan services-vendors-1004)", () => {
  const views = readFileSync(join(process.cwd(), "src/components/portal/manager-calendar-views.tsx"), "utf8");
  const agenda = views.slice(views.indexOf("export function CalendarAgendaView"), views.indexOf("export function CalendarDayPanel"));

  it("rows wear a neutral tile, not the type colour", () => {
    expect(agenda).not.toContain("kindStyle(");
    expect(agenda).not.toContain("var(--k)");
    expect(agenda).toContain("calendar-agenda-tile");
  });

  it("the type fact names who has it: Service · vendor, Task · teammate, Tour", async () => {
    const { agendaTypeFact } = await import("@/components/portal/manager-calendar-views");
    const item = (kind: "service" | "task" | "tour", assigneeLabel?: string) => ({ kind, meeting: { assigneeLabel } as never });
    expect(agendaTypeFact(item("service", "Rapid Pipes"))).toBe("Service · Rapid Pipes");
    expect(agendaTypeFact(item("task", "Jordan Lee"))).toBe("Task · Jordan Lee");
    expect(agendaTypeFact(item("tour", "Ignored"))).toBe("Tour");
    expect(agendaTypeFact(item("service"))).toBe("Service");
  });

  it("the day header is a normal block above its rows (never sticky over the first row)", () => {
    const headerClass = /data-attr="calendar-agenda-day-header"[\s\S]*?className="([^"]*)"/.exec(agenda)?.[1] ?? "";
    expect(headerClass).toContain("flex");
    expect(headerClass).not.toMatch(/\bsticky\b/);
    expect(agenda).not.toContain("top-[var(--portal-calendar-header-top,0px)]");
    expect(panels.match(/"--portal-calendar-header-top"/g)).toHaveLength(1);
  });

  it("the empty strip has no + of its own - the header + is the only create", () => {
    expect(panels).not.toContain("calendar-empty-add");
    const strip = views.slice(views.indexOf("export function CalendarEmptyStrip"), views.indexOf("legend"));
    expect(strip).not.toContain("addMenu");
  });

  it("a row and its Open menu item go through the record opener, with the dialog as fallback", () => {
    expect(panels).toContain("onOpenItem={openAgendaItem}");
    expect(panels).toContain("calendar-event-open-record");
  });
});
