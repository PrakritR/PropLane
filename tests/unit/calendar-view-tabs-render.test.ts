/**
 * Every routed calendar tab must render a view of its own.
 *
 * The failure this guards against is not a crash — it is a tab that renders the WRONG panel.
 * `portal-calendar.tsx` picks its view with a chain of booleans (`bookingsView`, then
 * `servicesOnlyView`, then tours as the fallback), so adding an id to `CALENDAR_VIEW_TABS`
 * without adding a branch silently lands it on tours, and adding one to the property strip
 * without a panel lands it on Bookings under someone else's label. Both look fine to a build,
 * to typecheck, and to every other test.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CALENDAR_VIEW_TABS,
  CALENDAR_VIEW_TAB_LABELS,
  PROPERTY_CALENDAR_SUB_TABS,
  PROPERTY_CALENDAR_SUB_TAB_LABELS,
  parseCalendarViewTab,
  parsePropertyCalendarSubTab,
} from "@/lib/portal-detail-routes";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("portfolio calendar tabs", () => {
  it("offers tours, service orders and bookings", () => {
    expect([...CALENDAR_VIEW_TABS]).toEqual(["tours", "services", "bookings"]);
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

  it("an unknown view lands on tours rather than 404ing", () => {
    // Old bookmarks and emailed links must keep working.
    for (const raw of ["all", "", null, undefined, "bogus"]) {
      expect(parseCalendarViewTab(raw)).toBe("tours");
    }
  });

  it("each non-default tab has its own render branch", () => {
    // Tours is the fallback branch, so it has no boolean of its own to find.
    const src = read("src/components/portal/portal-calendar.tsx");
    expect(src).toContain('const bookingsView = calendarView === "bookings"');
    expect(src).toContain('const servicesOnlyView = calendarView === "services"');
    // The dead literal that retired the view — if this comes back, the tab renders tours.
    expect(src).not.toContain("const bookingsView = false");
  });
});

describe("property calendar sub-tabs", () => {
  it("offers exactly the sub-views that have a panel", () => {
    // Services is deliberately absent: the services calendar is manager-wide and there is no
    // property-scoped panel, so a tab here would render the Bookings panel under a Services
    // label. Add the panel first, then the tab.
    expect([...PROPERTY_CALENDAR_SUB_TABS]).toEqual(["tours", "bookings"]);
  });

  it("every sub-tab has a label and round-trips", () => {
    for (const tab of PROPERTY_CALENDAR_SUB_TABS) {
      expect(PROPERTY_CALENDAR_SUB_TAB_LABELS[tab]?.trim()).toBeTruthy();
      expect(parsePropertyCalendarSubTab(tab)).toBe(tab);
    }
  });

  it("an unknown sub-view lands on tours", () => {
    for (const raw of ["", null, undefined, "services", "bogus"]) {
      expect(parsePropertyCalendarSubTab(raw)).toBe("tours");
    }
  });

  it("the strip is driven off the canonical list, not a second copy", () => {
    // A hardcoded second list is how the two tab sources drifted apart before.
    const src = read("src/components/portal/manager-property-calendar-panel.tsx");
    expect(src).toContain("PROPERTY_CALENDAR_SUB_TABS.map");
  });

  it("the panel branches on tours and falls through to bookings", () => {
    // With exactly two sub-tabs a binary is correct. Adding a third without changing this is
    // what would render the wrong panel, so this assertion is the tripwire.
    const src = read("src/components/portal/manager-property-calendar-panel.tsx");
    expect(src).toContain('calendarSubTab === "tours"');
    expect(PROPERTY_CALENDAR_SUB_TABS).toHaveLength(2);
  });
});
