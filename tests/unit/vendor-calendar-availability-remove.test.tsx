// @vitest-environment jsdom
/**
 * The vendor calendar's own availability blocks get the same one-click × the
 * manager's Tours availability blocks have (companion to
 * calendar-availability-slot-remove.test.tsx, which covers the manager path).
 * `canEditAvailability` now also turns on for `vendorViewer` when the caller
 * supplies `onVendorAvailabilityRemove` — this pins that the × calls ONLY
 * that callback (never the manager-only legacy schedule-record write), and
 * that turning it on never leaks the manager's week Availability menu or its
 * "+ Add availability" into the vendor calendar's own toolbar.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { PortalCalendarPanels } from "@/components/portal/portal-calendar-panels";
import { toLocalDateStr, startOfWeekMonday } from "@/lib/demo-admin-scheduling";

let PAINTED_SLOTS = new Set<string>();
const writeAvailability = vi.fn(async () => true);

vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => () => Promise.resolve(true),
  useAppUi: () => ({ showToast: vi.fn() }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/vendor/calendar",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("@/lib/rental-application/data", () => ({ getPropertyById: () => undefined }));
vi.mock("@/lib/manager-calendar-tour-meetings", () => ({
  buildScheduledTourMeetings: () => [],
}));
vi.mock("@/lib/demo-admin-scheduling", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    syncScheduleRecordsFromServer: vi.fn(async () => undefined),
    readAvailabilityDateSetForStorageKey: () => PAINTED_SLOTS,
    readPlannedEvents: () => [],
    writeAvailabilityDateSetForStorageKeyToServer: (...args: unknown[]) =>
      writeAvailability(...(args as [])),
  };
});

Element.prototype.scrollTo = Element.prototype.scrollTo ?? (() => {});
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => {});

function mondaySlotKey(hourSlot: number): string {
  const monday = startOfWeekMonday(new Date());
  return `${toLocalDateStr(monday)}:${hourSlot}`;
}

function mondayDs(): string {
  return toLocalDateStr(startOfWeekMonday(new Date()));
}

beforeEach(() => {
  PAINTED_SLOTS = new Set([mondaySlotKey(20), mondaySlotKey(21)]); // 10:00-11:00
  writeAvailability.mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ records: [] }) }) as unknown as Response),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("vendor availability delete: small × on the vendor's own run", () => {
  it("renders the × on the vendor's own painted block and calls onVendorAvailabilityRemove with the run's date + slots, never the manager legacy write", async () => {
    const onRemove = vi.fn();
    const { container } = render(
      <PortalCalendarPanels
        storageKey="vendor-calendar-availability-remove-test"
        vendorViewer
        hideViewModeControl
        compactAvailability
        bareSurface
        anchorDate={startOfWeekMonday(new Date())}
        onVendorAvailabilityRemove={onRemove}
      />,
    );

    const remove = container.querySelectorAll('[data-attr="calendar-remove-availability-slot"]');
    expect(remove.length).toBeGreaterThan(0);
    fireEvent.click(remove[0]!);

    expect(onRemove).toHaveBeenCalledWith(mondayDs(), 20, 22);
    expect(writeAvailability).not.toHaveBeenCalled();
  });

  it("never shows the × when the vendor calendar does not opt in with onVendorAvailabilityRemove", () => {
    const { container } = render(
      <PortalCalendarPanels
        storageKey="vendor-calendar-availability-remove-test-2"
        vendorViewer
        hideViewModeControl
        compactAvailability
        bareSurface
        anchorDate={startOfWeekMonday(new Date())}
      />,
    );
    expect(container.querySelectorAll('[data-attr="calendar-remove-availability-slot"]')).toHaveLength(0);
  });

  it("never leaks the manager's week Availability menu or its own Add-availability button into the vendor calendar toolbar", () => {
    const { container } = render(
      <PortalCalendarPanels
        storageKey="vendor-calendar-availability-remove-test-3"
        vendorViewer
        hideViewModeControl
        compactAvailability
        bareSurface
        anchorDate={startOfWeekMonday(new Date())}
        onVendorAvailabilityRemove={vi.fn()}
      />,
    );
    expect(container.querySelector('[data-attr="calendar-availability-menu"]')).toBeNull();
    expect(container.querySelector('[data-attr="calendar-create-block"]')).toBeNull();
  });
});
