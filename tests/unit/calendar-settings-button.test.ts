import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(join(process.cwd(), "src/components/portal/portal-calendar.tsx"), "utf8");

describe("calendar settings entry point", () => {
  it("shows Settings on manager availability view, not only the tours hub", () => {
    expect(SRC).toMatch(
      /const calendarSettingsButton\s*=\s*\n\s*portal === "manager" && availabilityView \?/,
    );
    expect(SRC).toContain('data-attr="calendar-settings-open"');
    expect(SRC).toContain("onCalendarSettingsSaved");
  });
});
