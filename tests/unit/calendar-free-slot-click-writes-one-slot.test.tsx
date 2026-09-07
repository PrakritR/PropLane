// @vitest-environment jsdom
/**
 * PRP-397 — the manager sets availability by clicking a FREE slot on the week
 * grid, and that click goes through the SAME write path "Add availability"
 * uses, so the public tour grid and the manager grid read one store.
 *
 * Three things have to hold for the click to be trustworthy:
 *
 *   1. A free cell (neither busy nor already open) writes EXACTLY that slotKey
 *      on top of what was already published — one key, on the storage key the
 *      calendar was given, and nothing for any other day or hour.
 *   2. A cell already holding a Google busy block does not write anything —
 *      it opens the block's details instead.
 *   3. An OPEN cell does not write either; it opens the slot's details (the
 *      per-slot "×" removal from PRP-414 is not on this branch, so the existing
 *      details-with-Delete behaviour is left alone).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PortalCalendarPanels, type DemoMeeting } from "@/components/portal/portal-calendar-panels";
import { startOfWeekMonday, toLocalDateStr } from "@/lib/demo-admin-scheduling";
import { resolveDefaultTourAvailabilityConfig } from "@/lib/tour-slot-math";

const STORAGE_KEY = "axis_mgr_avail_slots_v2_prp397";

/** What the calendar reads back for {@link STORAGE_KEY}. */
let PAINTED_SLOTS = new Set<string>();

const writeAvailability = vi.fn<(slots: Set<string>, key: string) => Promise<boolean>>(async () => true);
const syncScheduleRecords = vi.fn(async () => undefined);

vi.mock("@/components/providers/app-ui-provider", () => ({
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
// Spread the real module: a hand-listed mock silently drops every other export
// the panel imports, and the failure is a generic render error, not a TypeError.
vi.mock("@/lib/demo-admin-scheduling", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    syncScheduleRecordsFromServer: (...args: unknown[]) => syncScheduleRecords(...(args as [])),
    readAvailabilityDateSetForStorageKey: () => new Set(PAINTED_SLOTS),
    readPlannedEvents: () => [],
    writeAvailabilityDateSetForStorageKeyToServer: (...args: unknown[]) =>
      writeAvailability(...(args as [Set<string>, string])),
  };
});

Element.prototype.scrollTo = Element.prototype.scrollTo ?? (() => {});
Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => {});

/** A fixed week far in the future so nothing is "past" and nothing is today. */
const ANCHOR = new Date(2099, 7, 5, 12, 0, 0, 0); // Wed Aug 5 2099, local noon
const WEEK_MONDAY = startOfWeekMonday(ANCHOR);
const WEDNESDAY = toLocalDateStr(new Date(WEEK_MONDAY.getTime() + 2 * 24 * 60 * 60 * 1000));
/** 10:00 local — inside the grid's visible rows (6 AM – 10 PM). */
const TEN_AM_SLOT = 20;
const SLOT_KEY = `${WEDNESDAY}:${TEN_AM_SLOT}`;

function googleBusyAt(dateStr: string, slot: number): DemoMeeting {
  const [y, m, d] = dateStr.split("-").map(Number);
  const start = new Date(y!, m! - 1, d!, Math.floor(slot / 2), (slot % 2) * 30, 0, 0);
  return {
    id: "google_busy",
    source: "external",
    sourceId: "gcal-busy",
    startIso: start.toISOString(),
    endIso: new Date(start.getTime() + 30 * 60 * 1000).toISOString(),
    dateStr,
    startSlot: slot,
    span: 1,
    durationMinutes: 30,
    title: "Dentist appointment",
    color: "bg-muted",
    statusLabel: "Blocked",
    googleCalendarPrivate: true,
  };
}

/** Exactly what the manager Calendar passes: compact grid, no 9-5 default band. */
function renderManagerCalendar(externalMeetings: DemoMeeting[] = []) {
  return render(
    <PortalCalendarPanels
      storageKey={STORAGE_KEY}
      calendarRefreshSignal={0}
      bareSurface
      compactAvailability
      availabilityHeading="Schedule"
      defaultTourAvailability={resolveDefaultTourAvailabilityConfig({ enabled: false })}
      externalMeetings={externalMeetings}
      anchorDate={ANCHOR}
      onAnchorDateChange={() => {}}
      preferEventCountsInDayHeader
      flowScroll
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  PAINTED_SLOTS = new Set<string>();
  window.sessionStorage?.clear();
});

afterEach(cleanup);

/**
 * The compact calendar renders the anchor day TWICE in jsdom — once in the
 * phone single-day column and once in the desktop week (CSS hides one of them
 * in a browser). Both are the same cell wired to the same handler; act on the
 * first and let the write count prove the click was handled exactly once.
 */
async function slotCell(name: string): Promise<HTMLElement> {
  const cells = await screen.findAllByRole("button", { name });
  expect(cells.length).toBeGreaterThan(0);
  return cells[0]!;
}

describe("clicking a free slot on the manager calendar", () => {
  it("writes exactly that slotKey through the availability store, on the calendar's own key", async () => {
    PAINTED_SLOTS = new Set([`${WEDNESDAY}:${TEN_AM_SLOT + 4}`]); // an unrelated 12:00 window
    renderManagerCalendar();

    fireEvent.click(await slotCell(`Add 10 am on ${WEDNESDAY}`));

    await waitFor(() => expect(writeAvailability).toHaveBeenCalledTimes(1));
    const [written, key] = writeAvailability.mock.calls[0]!;
    expect(key).toBe(STORAGE_KEY);
    // The clicked window joins what was already published — and ONLY that window.
    expect([...written].sort()).toEqual([SLOT_KEY, `${WEDNESDAY}:${TEN_AM_SLOT + 4}`].sort());
    expect([...written].filter((k) => !PAINTED_SLOTS.has(k))).toEqual([SLOT_KEY]);
  });

  it("paints only the clicked window when nothing was published yet", async () => {
    renderManagerCalendar();

    fireEvent.click(await slotCell(`Add 10 am on ${WEDNESDAY}`));

    await waitFor(() => expect(writeAvailability).toHaveBeenCalledTimes(1));
    expect([...writeAvailability.mock.calls[0]![0]]).toEqual([SLOT_KEY]);
  });

  it("does not write when the slot is held by a Google busy block — it opens the block", async () => {
    renderManagerCalendar([googleBusyAt(WEDNESDAY, TEN_AM_SLOT)]);

    const cell = await slotCell(`Open details for 10 am on ${WEDNESDAY}`);
    // The block is drawn with the event's own title (PRP-397).
    expect(cell.textContent).toContain("Dentist appointment");
    expect(cell.getAttribute("title")).toContain("Dentist appointment · Blocked");
    fireEvent.click(cell);

    await waitFor(() => expect(document.querySelector(".modal-panel")).not.toBeNull());
    expect(writeAvailability).not.toHaveBeenCalled();
  });

  it("does not write when the slot is already open — it opens the slot's details", async () => {
    PAINTED_SLOTS = new Set([SLOT_KEY]);
    renderManagerCalendar();

    const cell = await slotCell(`Open details for 10 am on ${WEDNESDAY}`);
    expect(cell.textContent).toBe("Open");
    fireEvent.click(cell);

    await waitFor(() => expect(document.querySelector(".modal-panel")).not.toBeNull());
    expect(screen.getByText("Open tour window")).toBeTruthy();
    expect(writeAvailability).not.toHaveBeenCalled();
  });
});
