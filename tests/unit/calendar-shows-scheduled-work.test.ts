/**
 * The Calendar section answers one question: is anyone going into this property, or is anything
 * scheduled to be done there?
 *
 * It was answering "nothing, ever". Calendar → Availability rendered 0 EVENTS on every day of a
 * week where the Tours tab showed two, because both of its event sources were gated on the Tours
 * hub rather than on the view:
 *
 *   - `scheduledTourFilter` was passed only when `schedulingHub && toursHubTab === "tours"`, so
 *     the Calendar section always received `undefined` and drew no tours;
 *   - service visits were merged into `externalMeetings` only when `showServiceVisits`, which is
 *     the hub's Services tab, so the Calendar section never saw a service visit either.
 *
 * Neither shows up in a build or a typecheck — an empty calendar renders perfectly — so this
 * asserts the wiring directly.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(join(process.cwd(), "src/components/portal/portal-calendar.tsx"), "utf8");

describe("Calendar shows scheduled work", () => {
  it("passes the scheduled-tour filter on any availability view, not just the Tours hub", () => {
    expect(SRC).toContain(
      "availabilityView && calendarScheduledTourFilter ? calendarScheduledTourFilter : undefined",
    );
    // The old hub-only gate is what made the Calendar section blind to tours.
    expect(SRC).not.toContain('schedulingHub && toursHubTab === "tours" && calendarScheduledTourFilter');
  });

  it("merges service visits for the Calendar section too", () => {
    expect(SRC).toContain("const showScheduledWorkOnCalendar = !schedulingHub && availabilityView");
    expect(SRC).toContain("if (showServiceVisits || showScheduledWorkOnCalendar)");
  });

  it("keeps the Tours hub's own service view working", () => {
    // The hub's Services tab must still merge them — this widened the condition, it did not move it.
    expect(SRC).toContain("showServiceVisits");
    expect(SRC).toMatch(/showServiceVisits = schedulingHub && toursHubTab === "services"/);
  });

  it("recomputes when the service meetings change", () => {
    // A stale memo would reintroduce the empty calendar for the rest of the session.
    const memo = SRC.slice(SRC.indexOf("const mergedExternalMeetings"));
    expect(memo).toContain("showScheduledWorkOnCalendar,");
    expect(memo).toContain("serviceCalendarMeetings,");
  });
});

describe("nav icons", () => {
  const ICONS = readFileSync(
    join(process.cwd(), "src/components/portal/admin-portal-nav-icons.tsx"),
    "utf8",
  );

  it("gives Tours a real glyph instead of the fallback circle", () => {
    // `SECTION_ICONS[section] ?? Circle` is the fallback, and "tours" (plural) was missing, which
    // is why the nav showed an empty circle.
    expect(ICONS).toMatch(/^\s*tours: \w+,/m);
    expect(ICONS).not.toMatch(/^\s*tours: Circle,/m);
  });

  it("does not reuse the Calendar glyph for Tours", () => {
    // Calendar sits a few rows below Tours in the same nav; two identical glyphs read as a bug.
    expect(ICONS).not.toMatch(/^\s*tours: Calendar,/m);
  });

  it("keeps a fallback for unknown sections", () => {
    expect(ICONS).toContain("SECTION_ICONS[section] ?? Circle");
  });

  it("gives Bookings a real glyph instead of the fallback circle", () => {
    expect(ICONS).toMatch(/^\s*bookings: \w+,/m);
    expect(ICONS).not.toMatch(/^\s*bookings: Circle,/m);
  });

  it("does not reuse the Calendar glyph for Bookings", () => {
    expect(ICONS).not.toMatch(/^\s*bookings: Calendar,/m);
  });
});

describe("calendar portfolio scope", () => {
  const scopeSrc = readFileSync(join(process.cwd(), "src/components/portal/portal-calendar.tsx"), "utf8");

  it("writes availability for every scoped house, not only a single filter", () => {
    expect(scopeSrc).toContain("scopedCalendarPropertyIds.map((id) => managerPropertyAvailabilityStorageKey");
    expect(scopeSrc).not.toContain("activeCalendarPropertyFilters.length !== 1");
  });
});
