// @vitest-environment jsdom
//
// The Calendar header is one row (studio-redesign-0929 C2-CALP1/CALP2/CALP7):
// All / Tours / Services / Tasks tabs with counts and a type-colour dot, then
// Search, < Today > with the range, the view dropdown, Filter, the clock and +.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { DestinationNav } from "@/components/ui/destination-nav";
import { CALENDAR_KIND_COLOR } from "@/lib/calendar-grid";

vi.mock("next/navigation", () => ({
  usePathname: () => "/portal/calendar",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
}));

afterEach(cleanup);

const page = readFileSync(join(process.cwd(), "src/components/portal/portal-calendar.tsx"), "utf8");
const panels = readFileSync(join(process.cwd(), "src/components/portal/portal-calendar-panels.tsx"), "utf8");

describe("tab dots", () => {
  it("draws a small dot in the type colour before Tours, Services and Tasks — the tabs are the legend", () => {
    const { container } = render(
      <DestinationNav
        appearance="command"
        activeId="all"
        items={[
          { id: "all", label: "All", href: "/portal/calendar", count: 6 },
          { id: "tours", label: "Tours", href: "/portal/calendar/tours", count: 2, dotColor: CALENDAR_KIND_COLOR.tour },
          { id: "services", label: "Services", href: "/portal/calendar/services", count: 1, dotColor: CALENDAR_KIND_COLOR.service },
          { id: "tasks", label: "Tasks", href: "/portal/calendar/tasks", count: 2, dotColor: CALENDAR_KIND_COLOR.task },
        ]}
      />,
    );
    const dots = [...container.querySelectorAll('[data-slot="destination-nav-dot"]')] as HTMLElement[];
    expect(dots).toHaveLength(3);
    expect(dots.map((d) => d.style.backgroundColor)).toEqual(["rgb(42, 120, 214)", "rgb(235, 104, 52)", "rgb(27, 175, 122)"]);
    expect(dots.every((d) => d.getAttribute("aria-hidden") === "true")).toBe(true);
    // The All tab has no dot.
    expect(container.querySelector('a[href="/portal/calendar"] [data-slot="destination-nav-dot"]')).toBeNull();
  });

  it("the page gives the three type tabs their dot colours", () => {
    expect(page).toContain("tours: CALENDAR_KIND_COLOR.tour,");
    expect(page).toContain("services: CALENDAR_KIND_COLOR.service,");
    expect(page).toContain("tasks: CALENDAR_KIND_COLOR.task,");
    expect(page).toContain('dotColor: "dotColor" in tab ? tab.dotColor : undefined,');
  });
});

describe("one header row", () => {
  it("orders the controls < Today > + range + view, then Filter, the clock and +", () => {
    const nav = page.indexOf('data-slot="calendar-nav-host"');
    const filter = page.indexOf("{calendarFilterSheet}", nav);
    const clock = page.indexOf('data-slot="calendar-week-actions-host"');
    const plus = page.indexOf('data-slot="calendar-primary-action-host"');
    expect(nav).toBeGreaterThan(0);
    expect(filter).toBeGreaterThan(nav);
    expect(clock).toBeGreaterThan(filter);
    expect(plus).toBeGreaterThan(clock);
  });

  it("has no second control row: no 6 am - 10 pm pickers, no ← → arrows, no Day/Week/Month pills", () => {
    const studio = panels.slice(panels.indexOf("if (studioActive) {"), panels.indexOf("if (compactAvailability) {"));
    expect(studio).toContain("<ChevronLeft");
    expect(studio).toContain("<ChevronRight");
    expect(studio).not.toContain("renderTimeWindowControl");
    expect(studio).not.toContain("PortalSegmentedControl");
    expect(studio).not.toContain("←");
    expect(studio).toContain('label="Calendar view"');
    // The view picker is a dropdown, never a raw select.
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

  it("a phone keeps the nav controls under the header card and defaults to Agenda, remembered per device", () => {
    expect(page).toContain("max-sm:hidden");
    expect(panels).toContain("const hostedNav = Boolean(navControlsHost) && !phone;");
    const pref = readFileSync(join(process.cwd(), "src/lib/manager-calendar-view-preference.ts"), "utf8");
    expect(pref).toContain('return isPhone ? "agenda" : "week";');
    expect(pref).toContain("managerCalendarViewStorageKey(isPhone)");
  });
});
