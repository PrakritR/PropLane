/**
 * Every routed calendar tab must render a view of its own.
 *
 * Tours and service orders moved to `/portal/tours`; calendar is availability + bookings only.
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

describe("portfolio calendar tabs", () => {
  it("offers availability and bookings", () => {
    expect([...CALENDAR_VIEW_TABS]).toEqual(["availability", "bookings"]);
  });

  it("every tab has a label", () => {
    for (const tab of CALENDAR_VIEW_TABS) {
      expect(CALENDAR_VIEW_TAB_LABELS[tab]?.trim()).toBeTruthy();
    }
  });

  it("every tab round-trips through the parser", () => {
    for (const tab of CALENDAR_VIEW_TABS) {
      expect(parseCalendarViewTab(tab)).toBe(tab);
    }
  });

  it("legacy tour and service paths land on availability", () => {
    for (const raw of ["all", "tours", "services", "", null, undefined, "bogus"]) {
      expect(parseCalendarViewTab(raw)).toBe("availability");
    }
  });

  it("each non-default tab has its own render branch", () => {
    const src = read("src/components/portal/portal-calendar.tsx");
    expect(src).toContain('const bookingsView = !schedulingHub && calendarView === "bookings"');
    expect(src).toContain('calendarView === "availability"');
    expect(src).toContain("schedulingHub");
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

  it("property calendar panel is bookings-only", () => {
    const src = read("src/components/portal/manager-property-calendar-panel.tsx");
    expect(src).toContain("ManagerPropertyBookingsPanel");
    expect(src).not.toContain('calendarSubTab === "tours"');
  });
});
