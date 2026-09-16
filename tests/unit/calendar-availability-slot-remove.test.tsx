// @vitest-environment jsdom
/**
 * PRP-373 — pinned availability footer keeps an in-flow spacer so last slots clear the dock.
 * PRP-414 — each painted "Open" slot exposes a visible × to remove just that window.
 * PLAN-0914-1710 — a contiguous run of painted slots merges into one block with
 * exactly one × instead of one × per 30-minute cell; a gap between painted
 * slots stays two separate runs, each with its own ×.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { PortalCalendarPanels } from "@/components/portal/portal-calendar-panels";
import { toLocalDateStr, startOfWeekMonday } from "@/lib/demo-admin-scheduling";
import { resolveDefaultTourAvailabilityConfig } from "@/lib/tour-slot-math";

let PAINTED_SLOTS = new Set<string>();
const writeAvailability = vi.fn(async () => true);

vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => (req: { description?: unknown }) =>
    Promise.resolve(
      typeof window === "undefined"
        ? true
        : window.confirm(typeof req?.description === "string" ? req.description : "Are you sure?"),
    ),

  useAppUi: () => ({ showToast: vi.fn() }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/portal/calendar",
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

beforeEach(() => {
  PAINTED_SLOTS = new Set([mondaySlotKey(20)]); // 10:00
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

function renderTourAvailability() {
  return render(
    <PortalCalendarPanels
      storageKey="axis_mgr_avail_slots_v2_test"
      compactAvailability
      bareSurface
      availabilityHeading="Tour availability"
      defaultTourAvailability={resolveDefaultTourAvailabilityConfig({ enabled: false })}
      // Pin the anchor to Monday so the mobile single-day strip and the desktop
      // week grid both land on the date `mondaySlotKey` paints, regardless of
      // which real-world weekday the suite happens to run on.
      anchorDate={startOfWeekMonday(new Date())}
    />,
  );
}

describe("tour availability slot remove (PRP-414)", () => {
  it("shows a remove control on each painted Open slot", () => {
    const { container } = renderTourAvailability();
    const removes = container.querySelectorAll('[data-attr="calendar-remove-availability-slot"]');
    // Mobile day grid + desktop week grid both paint the same open slot.
    expect(removes.length).toBeGreaterThanOrEqual(1);
  });

  it("removes only that slot when × is clicked", async () => {
    const { container } = renderTourAvailability();
    const remove = container.querySelector(
      '[data-attr="calendar-remove-availability-slot"]',
    ) as HTMLButtonElement;
    expect(remove).toBeTruthy();
    fireEvent.click(remove);
    await waitFor(() => {
      expect(writeAvailability).toHaveBeenCalled();
    });
    const written = writeAvailability.mock.calls.at(-1)?.[0] as Set<string> | undefined;
    expect(written?.has(mondaySlotKey(20))).toBe(false);
  });
});

describe("merged open runs get exactly one × (PLAN-0914-1710)", () => {
  it("shows exactly one remove button for a contiguous 3-slot run", () => {
    PAINTED_SLOTS = new Set([mondaySlotKey(20), mondaySlotKey(21), mondaySlotKey(22)]); // 10:00-11:30
    const { container } = renderTourAvailability();
    // One run per grid (mobile day strip + desktop week grid render the same day).
    const removes = container.querySelectorAll('[data-attr="calendar-remove-availability-slot"]');
    expect(removes.length).toBe(2);
  });

  it("clicking the run's × removes every slot in the run", async () => {
    PAINTED_SLOTS = new Set([mondaySlotKey(20), mondaySlotKey(21), mondaySlotKey(22)]);
    const { container } = renderTourAvailability();
    const remove = container.querySelector(
      '[data-attr="calendar-remove-availability-slot"]',
    ) as HTMLButtonElement;
    expect(remove).toBeTruthy();
    fireEvent.click(remove);
    await waitFor(() => {
      expect(writeAvailability).toHaveBeenCalled();
    });
    const written = writeAvailability.mock.calls.at(-1)?.[0] as Set<string> | undefined;
    expect(written?.has(mondaySlotKey(20))).toBe(false);
    expect(written?.has(mondaySlotKey(21))).toBe(false);
    expect(written?.has(mondaySlotKey(22))).toBe(false);
  });

  it("a gap between painted slots stays two separate runs, each with its own ×", () => {
    PAINTED_SLOTS = new Set([mondaySlotKey(20), mondaySlotKey(22)]); // 10:00 and 11:00, 10:30 empty
    const { container } = renderTourAvailability();
    // Two runs per grid × two grids (mobile + desktop) = four buttons.
    const removes = container.querySelectorAll('[data-attr="calendar-remove-availability-slot"]');
    expect(removes.length).toBe(4);
  });
});

describe("availability footer clearance (PRP-373)", () => {
  it("keeps an in-flow spacer under the pinned action dock", () => {
    const { container } = renderTourAvailability();
    const footer = container.querySelector('[data-slot="portal-page-footer-actions"][data-pinned]');
    expect(footer).toBeTruthy();
    // Spacer is the previous sibling of the fixed dock (PortalPageFooterActions without omitSpacer).
    const spacer = footer?.previousElementSibling as HTMLElement | null;
    expect(spacer).toBeTruthy();
    expect(spacer?.hasAttribute("aria-hidden")).toBe(true);
  });
});
