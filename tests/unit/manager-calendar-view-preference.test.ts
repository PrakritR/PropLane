import { describe, expect, it } from "vitest";
import {
  defaultManagerCalendarViewMode,
  managerCalendarViewStorageKey,
} from "@/lib/manager-calendar-view-preference";

describe("manager calendar view preference", () => {
  it("defaults to week on desktop and agenda on phone", () => {
    expect(defaultManagerCalendarViewMode(false)).toBe("week");
    expect(defaultManagerCalendarViewMode(true)).toBe("agenda");
  });

  it("uses separate storage keys per device class", () => {
    expect(managerCalendarViewStorageKey(false)).toContain("desktop");
    expect(managerCalendarViewStorageKey(true)).toContain("phone");
  });
});
