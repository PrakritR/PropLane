import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CALENDAR = readFileSync(join(process.cwd(), "src/components/portal/portal-calendar.tsx"), "utf8");
const TOURS = readFileSync(join(process.cwd(), "src/components/portal/manager-tours.tsx"), "utf8");

/**
 * Tour rules live in the Tours section, and nowhere else.
 *
 * The Calendar used to carry a Settings button opening the very same panel —
 * notice required, auto-confirm, tour reminders. Sitting on the Calendar it read
 * as "calendar settings" and opened something else, which is worse than not
 * offering it: a manager looking for calendar rules found tour ones, and one
 * looking for tour rules had two places to find them.
 */
describe("tour settings entry point", () => {
  it("is not on the Calendar", () => {
    expect(CALENDAR).not.toContain('data-attr="calendar-settings-open"');
    expect(CALENDAR).not.toContain("ManagerPortalSettingsModal");
  });

  it("is on Tours, scoped to the Tours tab", () => {
    expect(TOURS).toContain('initialTab="tours"');
    expect(TOURS).toContain('scopedTitle="Tours"');
    expect(TOURS).not.toContain('scopedTitle="Calendar settings"');
  });
});
