import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CALENDAR = readFileSync(join(process.cwd(), "src/components/portal/portal-calendar.tsx"), "utf8");
const TOURS = readFileSync(join(process.cwd(), "src/components/portal/pro-tours.tsx"), "utf8");
const RESIDENTS = readFileSync(join(process.cwd(), "src/components/portal/pro-residents.tsx"), "utf8");

/**
 * Tour rules live on a resident's own Tours subsection, and nowhere else.
 *
 * The Calendar used to carry a Settings button opening the very same panel —
 * notice required, auto-confirm, tour reminders. Sitting on the Calendar it read
 * as "calendar settings" and opened something else, which is worse than not
 * offering it: a manager looking for calendar rules found tour ones, and one
 * looking for tour rules had two places to find them.
 *
 * S021 (captain, 2026-09-27): the Tours list page dropped its own header gear
 * — a duplicate entry point to the same reminder settings — leaving the
 * resident-detail Tours subsection as the one way in.
 */
describe("tour settings entry point", () => {
  it("is not on the Calendar", () => {
    expect(CALENDAR).not.toContain('data-attr="calendar-settings-open"');
    expect(CALENDAR).not.toContain("ManagerPortalSettingsModal");
  });

  it("is not on the Tours list page", () => {
    expect(TOURS).not.toContain('initialTab="tours"');
    expect(TOURS).not.toContain("toursSettingsEntry");
  });

  it("is reachable from a resident's Tours subsection", () => {
    expect(RESIDENTS).toContain('openResidentDetailSettings("tours")');
  });
});
