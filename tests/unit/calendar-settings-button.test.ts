import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(join(process.cwd(), "src/components/portal/portal-calendar.tsx"), "utf8");

describe("calendar settings entry point", () => {
  it("shows Settings on manager availability view and wires save refresh", () => {
    expect(SRC).toContain('data-attr="calendar-settings-open"');
    expect(SRC).toContain("onCalendarSettingsSaved");
    expect(SRC).toMatch(/calendarSettingsButton[\s\S]*availabilityView/);
    expect(SRC).not.toContain('scopedTitle="Calendar settings"');
  });
});
