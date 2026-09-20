// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import {
  calendarTodayAnchor,
  calendarVisibleDateCount,
  PortalCalendarPanels,
  shiftCalendarAnchor,
  type CalendarMode,
} from "@/components/portal/portal-calendar-panels";

const scheduleWrite = vi.fn(async () => true);
const scheduleSync = vi.fn(async () => true);

vi.mock("@/components/providers/app-ui-provider", () => ({ useAppUi: () => ({ showToast: vi.fn() }) }));
vi.mock("@/lib/rental-application/data", () => ({ getPropertyById: () => undefined }));
vi.mock("@/lib/manager-calendar-tour-meetings", () => ({ buildScheduledTourMeetings: () => [] }));
vi.mock("@/lib/demo-admin-scheduling", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    readAvailabilityDateSetForStorageKey: () => new Set<string>(),
    readPlannedEvents: () => [],
    syncScheduleRecordsFromServer: (...args: unknown[]) => scheduleSync(...(args as [])),
    writeAvailabilityDateSetForStorageKeyToServer: (...args: unknown[]) => scheduleWrite(...(args as [])),
  };
});

const ANCHOR = new Date(2099, 7, 5, 12, 0, 0, 0);
const stamp = (date: Date) => date.toISOString().slice(0, 10);

afterEach(() => {
  cleanup();
  scheduleWrite.mockClear();
  scheduleSync.mockClear();
  vi.useRealTimers();
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2099, 7, 5, 12, 0, 0, 0));
});

describe("vendor calendar navigation", () => {
  it("moves one mode unit and returns to Today without a DST-sensitive date jump", () => {
    expect(stamp(shiftCalendarAnchor(ANCHOR, "day", 1))).toBe("2099-08-06");
    expect(stamp(shiftCalendarAnchor(ANCHOR, "week", 1))).toBe("2099-08-12");
    expect(stamp(shiftCalendarAnchor(ANCHOR, "month", 1))).toBe("2099-09-05");
    expect(stamp(calendarTodayAnchor(ANCHOR))).toBe("2099-08-05");
  });

  it("uses one date for Day, seven for Week, and the actual month length for Month", () => {
    expect(calendarVisibleDateCount("day", ANCHOR)).toBe(1);
    expect(calendarVisibleDateCount("week", ANCHOR)).toBe(7);
    expect(calendarVisibleDateCount("month", ANCHOR)).toBe(31);
  });

  it("keeps vendor Week navigation interactive while slot edits never write legacy schedule records", () => {
    const editCanonicalAvailability = vi.fn();
    function VendorWeek() {
      const [anchor, setAnchor] = useState(ANCHOR);
      return (
        <PortalCalendarPanels
          storageKey="vendor-calendar-test"
          readOnly
          vendorViewer
          compactAvailability
          defaultViewMode="week"
          viewMode="week"
          anchorDate={anchor}
          onAnchorDateChange={setAnchor}
          onVendorAvailabilityEdit={editCanonicalAvailability}
        />
      );
    }
    render(<VendorWeek />);

    fireEvent.click(screen.getByRole("button", { name: "Next week" }));
    expect(screen.getByText("8/10–8/16")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    expect(screen.getByText("8/3–8/9")).toBeTruthy();

    const emptyVendorSlot = document.querySelector<HTMLButtonElement>(
      '[data-availability-date="2099-08-03"][data-availability-slot="12"]',
    );
    expect(emptyVendorSlot).toHaveAttribute("data-availability-state", "empty");
    fireEvent.click(emptyVendorSlot!);
    expect(editCanonicalAvailability).toHaveBeenCalledWith("2099-08-03", 12);
    expect(scheduleWrite).not.toHaveBeenCalled();
    expect(scheduleSync).not.toHaveBeenCalled();
  });

  it("renders the route-owned Day, Week, and Month DOM with mode-sized navigation", () => {
    const modes: CalendarMode[] = ["day", "week", "month"];
    for (const mode of modes) {
      const onAnchorDateChange = vi.fn();
      const { unmount } = render(
        <PortalCalendarPanels
          storageKey="vendor-calendar-test"
          readOnly
          vendorViewer
          defaultViewMode={mode}
          viewMode={mode}
          hideViewModeControl
          anchorDate={ANCHOR}
          onAnchorDateChange={onAnchorDateChange}
        />,
      );
      expect(screen.getByRole("button", { name: "Today" })).toBeTruthy();
      expect(screen.queryByRole("tab", { name: "Day" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: `Next ${mode}` }));
      expect(onAnchorDateChange).toHaveBeenCalledWith(shiftCalendarAnchor(ANCHOR, mode, 1));
      fireEvent.click(screen.getByRole("button", { name: "Today" }));
      expect(onAnchorDateChange).toHaveBeenLastCalledWith(new Date(2099, 7, 5, 12, 0, 0, 0));
      expect(scheduleSync).not.toHaveBeenCalled();
      if (mode === "day") expect(document.querySelectorAll('[data-slot="calendar-day-header"]')).toHaveLength(1);
      if (mode === "week") expect(document.querySelectorAll('[data-slot="calendar-week-date"]')).toHaveLength(7);
      if (mode === "month") expect(document.querySelectorAll('[data-slot="calendar-month-grid"] button')).toHaveLength(31);
      unmount();
    }
  });
});
