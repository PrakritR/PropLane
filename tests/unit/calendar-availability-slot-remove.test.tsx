// @vitest-environment jsdom
/**
 * PLAN-0916-1034 — week actions are toolbar icons; the pinned footer dock is gone.
 * Super plan item 43 — a small × on the first cell of an open run removes that
 * run. Delete block in the click-through dialog remains.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

function mondayDs(): string {
  return toLocalDateStr(startOfWeekMonday(new Date()));
}

describe("availability delete: small × on the run, dialog still works", () => {
  it("renders a small × on a painted block that removes that run", async () => {
    PAINTED_SLOTS = new Set([mondaySlotKey(20), mondaySlotKey(21)]); // 10:00-11:00
    const { container } = renderTourAvailability();
    const remove = container.querySelectorAll('[data-attr="calendar-remove-availability-slot"]');
    expect(remove.length).toBeGreaterThan(0);
    expect(remove[0]).toHaveClass("h-4", "w-4");
    fireEvent.click(remove[0]!);
    await waitFor(() => {
      expect(writeAvailability).toHaveBeenCalled();
    });
    const written = writeAvailability.mock.calls.at(-1)?.[0] as Set<string> | undefined;
    expect(written?.has(mondaySlotKey(20))).toBe(false);
    expect(written?.has(mondaySlotKey(21))).toBe(false);
  });

  it("Delete block in the dialog removes that single slot", async () => {
    PAINTED_SLOTS = new Set([mondaySlotKey(20)]); // 10:00
    const { container } = renderTourAvailability();
    const cell = container.querySelector(
      `[aria-label="Open details for 10 am on ${mondayDs()}"]`,
    ) as HTMLButtonElement;
    expect(cell).toBeTruthy();
    fireEvent.click(cell);
    await waitFor(() => expect(document.querySelector(".modal-panel")).not.toBeNull());
    fireEvent.click(screen.getAllByText("Delete block")[0]!);
    await waitFor(() => {
      expect(writeAvailability).toHaveBeenCalled();
    });
    const written = writeAvailability.mock.calls.at(-1)?.[0] as Set<string> | undefined;
    expect(written?.has(mondaySlotKey(20))).toBe(false);
  });

  it("Delete block removes every slot in a contiguous run", async () => {
    PAINTED_SLOTS = new Set([mondaySlotKey(20), mondaySlotKey(21), mondaySlotKey(22)]); // 10:00-11:30
    const { container } = renderTourAvailability();
    const cell = container.querySelector(
      `[aria-label="Open details for 10 am on ${mondayDs()}"]`,
    ) as HTMLButtonElement;
    expect(cell).toBeTruthy();
    fireEvent.click(cell);
    await waitFor(() => expect(document.querySelector(".modal-panel")).not.toBeNull());
    fireEvent.click(screen.getAllByText("Delete block")[0]!);
    await waitFor(() => {
      expect(writeAvailability).toHaveBeenCalled();
    });
    const written = writeAvailability.mock.calls.at(-1)?.[0] as Set<string> | undefined;
    expect(written?.has(mondaySlotKey(20))).toBe(false);
    expect(written?.has(mondaySlotKey(21))).toBe(false);
    expect(written?.has(mondaySlotKey(22))).toBe(false);
  });

  it("Save changes in the dialog re-applies the block with edited hours", async () => {
    PAINTED_SLOTS = new Set([mondaySlotKey(20)]); // 10:00-10:30
    const { container } = renderTourAvailability();
    const cell = container.querySelector(
      `[aria-label="Open details for 10 am on ${mondayDs()}"]`,
    ) as HTMLButtonElement;
    expect(cell).toBeTruthy();
    fireEvent.click(cell);
    await waitFor(() => expect(document.querySelector(".modal-panel")).not.toBeNull());
    // The dialog is the create form, prefilled — Save changes writes.
    fireEvent.click(screen.getAllByText("Save changes")[0]!);
    await waitFor(() => {
      expect(writeAvailability).toHaveBeenCalled();
    });
  });
});

describe("availability week actions (PLAN-0916-1034)", () => {
  it("puts Copy / Add / Clear / Houses on the week toolbar, not a pinned footer", () => {
    const { container } = renderTourAvailability();
    expect(container.querySelector('[data-slot="portal-page-footer-actions"]')).toBeNull();
    const toolbar = container.querySelector(".portal-calendar-toolbar");
    expect(toolbar).toBeTruthy();
    const actions = toolbar?.querySelector('[data-slot="calendar-week-actions"]');
    expect(actions).toBeTruthy();
    expect(actions?.querySelector('[data-attr="calendar-copy-previous-week"]')).toBeTruthy();
    expect(actions?.querySelector('[data-attr="calendar-create-block"]')).toBeTruthy();
    expect(actions?.querySelector('[data-attr="calendar-clear-week"]')).toBeTruthy();
    expect(actions?.querySelector('[data-attr="calendar-copy-to-houses"]')).toBeTruthy();
    expect(screen.getByLabelText("Copy previous week").closest("[data-slot='portal-icon-action']")).toBeTruthy();
  });
});
