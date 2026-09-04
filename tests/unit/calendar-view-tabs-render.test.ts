/**
 * Portfolio calendar is schedule-only; Bookings is a separate sidebar section.
 * Tours and service orders live at `/portal/tours`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CALENDAR_VIEW_TABS,
  CALENDAR_VIEW_TAB_LABELS,
  PROPERTY_CALENDAR_SUB_TABS,
  PROPERTY_CALENDAR_SUB_TAB_LABELS,
  TOURS_HUB_TABS,
  parseCalendarViewTab,
  parsePropertyCalendarSubTab,
  parseToursHubTab,
} from "@/lib/portal-detail-routes";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("portfolio calendar and bookings nav", () => {
  it("still parses availability and bookings view ids for PortalCalendar", () => {
    expect([...CALENDAR_VIEW_TABS]).toEqual(["availability", "bookings"]);
  });

  it("every view id has a label", () => {
    for (const tab of CALENDAR_VIEW_TABS) {
      expect(CALENDAR_VIEW_TAB_LABELS[tab]?.trim()).toBeTruthy();
    }
  });

  it("every view id round-trips through the parser", () => {
    for (const tab of CALENDAR_VIEW_TABS) {
      expect(parseCalendarViewTab(tab)).toBe(tab);
    }
  });

  it("legacy tour and service paths land on availability", () => {
    for (const raw of ["all", "tours", "services", "", null, undefined, "bogus"]) {
      expect(parseCalendarViewTab(raw)).toBe("availability");
    }
  });

  it("calendar page has no Schedule/Bookings tab strip; bookings is a dedicated page", () => {
    const src = read("src/components/portal/portal-calendar.tsx");
    expect(src).toContain('const bookingsView = !schedulingHub && calendarView === "bookings"');
    expect(src).toContain("bookingsPage");
    expect(src).not.toContain('label: "Schedule"');
    expect(src).not.toContain('label: "Bookings"');
    const nav = read("src/lib/portals/nav-groups.ts");
    expect(nav).toContain('"bookings"');
    const render = read("src/lib/render-portal-section.tsx");
    expect(render).toContain('section === "bookings"');
  });

  it("calendar index route renders the schedule view instead of self-redirecting", () => {
    const page = read("src/app/portal/calendar/page.tsx");
    expect(page).toContain('renderProPortalSection("calendar")');
    expect(page).not.toContain('redirect("/portal/calendar")');
  });
});

describe("portfolio tours hub", () => {
  it("offers tours and service orders segments", () => {
    expect([...TOURS_HUB_TABS]).toEqual(["tours", "services"]);
  });

  it("unknown segment lands on tours", () => {
    expect(parseToursHubTab("bogus")).toBe("tours");
    expect(parseToursHubTab("services")).toBe("services");
  });
});

describe("property calendar sub-tabs", () => {
  it("is bookings-only after tours moved to their own tab", () => {
    expect([...PROPERTY_CALENDAR_SUB_TABS]).toEqual(["bookings"]);
  });

  it("every sub-tab has a label and round-trips", () => {
    for (const tab of PROPERTY_CALENDAR_SUB_TABS) {
      expect(PROPERTY_CALENDAR_SUB_TAB_LABELS[tab]?.trim()).toBeTruthy();
      expect(parsePropertyCalendarSubTab(tab)).toBe(tab);
    }
  });

  it("legacy tours sub-path lands on bookings", () => {
    expect(parsePropertyCalendarSubTab("tours")).toBe("bookings");
  });

  it("PRP-165: the house's Bookings panel is reachable from its own detail tabs", () => {
    // `ManagerPropertyCalendarPanel` was a pass-through wrapper that rendered
    // ManagerPropertyBookingsPanel and that NOTHING rendered in turn, so one
    // house's occupancy could only be seen by leaving it for the portfolio
    // Bookings page and filtering back down. The wrapper is deleted; the panel
    // is now a Bookings tab beside Tours.
    const panel = read("src/components/portal/pro-house-properties-panel.tsx");
    expect(panel).toContain("ManagerPropertyBookingsPanel");
    expect(panel).toContain('activeDetailTab === "bookings"');
    expect(panel).toContain('pushTopTab("bookings", "bookings")');
  });
});
