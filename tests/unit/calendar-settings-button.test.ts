import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(join(process.cwd(), "src/components/portal/portal-calendar.tsx"), "utf8");

describe("calendar settings entry point", () => {
  it("shows Settings on the manager availability view and opens the scoped calendar tab", () => {
    // The save-refresh callback (`onCalendarSettingsSaved`) is gone: the modal is
    // opened `scoped` on `initialTab="calendar"` and the panel owns its own save.
    expect(SRC).toContain('data-attr="calendar-settings-open"');
    expect(SRC).toMatch(/calendarSettingsButton[\s\S]*availabilityView/);
    expect(SRC).toContain('initialTab="calendar"');
    expect(SRC).toContain('scopedTitle="Calendar"');
    expect(SRC).not.toContain('scopedTitle="Calendar settings"');
  });
});
