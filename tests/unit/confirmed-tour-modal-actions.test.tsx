// @vitest-environment jsdom
/**
 * A confirmed tour is not a one-way door, and its destructive actions are not
 * one click.
 *
 * The audit found the detail modal for a confirmed tour offered exactly two
 * controls:
 *
 *     [...panel.querySelectorAll("button,a")].map(e => e.textContent.trim())
 *     // → ["Close", "Delete event"]
 *
 * No reschedule, no cancel-with-notice. And `Delete event` fired with no
 * confirmation dialog, removed the tour instantly, and sent the guest nothing —
 * after PropLane had already emailed them "Your PropLane tour is confirmed".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PortalCalendarPanels, type DemoMeeting } from "@/components/portal/portal-calendar-panels";
import { startOfWeekMonday, toLocalDateStr } from "@/lib/demo-admin-scheduling";

/** Painted availability the calendar reads for the storage key under test. */
let PAINTED_SLOTS = new Set<string>();

const cancelFromServer = vi.fn(async () => ({ ok: true }));
const rescheduleFromServer = vi.fn(async () => ({ ok: true }));
const deletePlannedEvent = vi.fn(async () => true);
const syncScheduleRecords = vi.fn(async () => undefined);

vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast: vi.fn() }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("@/lib/tour-planned-change.client", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    cancelPlannedTourFromServer: (...args: unknown[]) => cancelFromServer(...(args as [])),
    reschedulePlannedTourFromServer: (...args: unknown[]) => rescheduleFromServer(...(args as [])),
  };
});
vi.mock("@/lib/google-calendar/delete-tour.client", () => ({
  deleteProplaneGoogleTourFromServer: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/rental-application/data", () => ({ getPropertyById: () => undefined }));
vi.mock("@/lib/manager-calendar-tour-meetings", () => ({
  buildScheduledTourMeetings: () => [],
}));

vi.mock("@/lib/demo-admin-scheduling", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    syncScheduleRecordsFromServer: (...args: unknown[]) => syncScheduleRecords(...(args as [])),
    readAvailabilityDateSetForStorageKey: () => PAINTED_SLOTS,
    readPlannedEvents: () => [],
    deletePlannedEventFromServer: (...args: unknown[]) => deletePlannedEvent(...(args as [])),
    deletePartnerInquiryFromServer: vi.fn(async () => true),
    acceptPartnerInquiryFromServer: vi.fn(async () => ({ ok: true })),
    writeAvailabilityDateSetForStorageKeyToServer: vi.fn(async () => true),
  };
});

/** A confirmed tour on today's calendar, injected as a caller-owned meeting. */
function confirmedTour(): DemoMeeting {
  const start = new Date();
  start.setHours(10, 0, 0, 0);
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    id: "planned-1",
    source: "planned",
    sourceId: "planned-1",
    startIso: start.toISOString(),
    endIso: end.toISOString(),
    dateStr: `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`,
    startSlot: 20,
    span: 1,
    durationMinutes: 30,
    title: "Tour · Audit Prospect",
    color: "emerald",
    kind: "tour",
    name: "Audit Prospect",
    email: "prospect@example.com",
    propertyTitle: "Ballard House",
  };
}

/**
 * The same shape as it arrives from the manager's linked Google Calendar: a
 * PropLane-looking "Tour · …" event whose `sourceId` is a GOOGLE event id, not
 * a row in `axis_admin_planned_events_v1`.
 */
function googleSourcedTour(): DemoMeeting {
  return { ...confirmedTour(), id: "gcal-1", source: "external", sourceId: "gcal-event-1" };
}

function renderCalendar(props: { onMeetingsChanged?: () => void; meeting?: DemoMeeting } = {}) {
  const { meeting, ...rest } = props;
  return render(
    <PortalCalendarPanels
      storageKey="axis_mgr_avail_slots_v2_test"
      externalMeetings={[meeting ?? confirmedTour()]}
      scheduleOwnerLabel="Test Manager"
      {...rest}
    />,
  );
}

function confirmGuestNotificationModal() {
  return waitFor(() => {
    const el = document.querySelector('[data-attr="portal-notification-confirm"]') as HTMLButtonElement | null;
    if (!el || el.disabled) throw new Error("confirm not ready");
    fireEvent.click(el);
    return el;
  });
}

/** Open the detail modal by clicking the tour's grid cell. */
async function openTourModal() {
  const cell = await waitFor(() => {
    const hit = [...document.querySelectorAll("button")].find((el) =>
      el.textContent?.includes("Audit Prospect"),
    );
    if (!hit) throw new Error("tour cell not rendered");
    return hit;
  });
  fireEvent.click(cell);
  await waitFor(() => {
    if (!document.querySelector(".modal-panel")) throw new Error("modal not open");
  });
}

function modalButtonLabels(): string[] {
  const panel = document.querySelector(".modal-panel");
  return [...(panel?.querySelectorAll("button,a") ?? [])]
    .map((el) => el.textContent?.trim() ?? "")
    .filter(Boolean);
}

afterEach(cleanup);

/**
 * Pin the clock to a Monday 06:00, BEFORE the 10:00 windows these tests paint.
 *
 * The fixtures build their days from `new Date()`, so on a real clock the painted
 * week is already past by midweek and today's 10:00 slot is past by late morning.
 * `slotIsBookable` then drops every painted slot and the grid reports the 9-5
 * default instead — a failure that depended on the day and hour the suite ran.
 */
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date(2026, 7, 10, 6, 0, 0, 0));
  vi.clearAllMocks();
  PAINTED_SLOTS = new Set<string>();
});
afterEach(() => {
  vi.useRealTimers();
});

/**
 * Paint EVERY day of the pinned week.
 *
 * `resolveTourOfferingSlots` merges the 9-5 default into any horizon day with no
 * future published window of its own, and the week badge totals the whole visible
 * week — so painting one or two days left the other five defaulting and the badge
 * counted them too (5 x 16 = 80 extra). Publishing every day keeps the default out
 * of the number entirely, so the badge is once again exactly "painted minus taken"
 * and each subtraction below stays legible.
 */
function paintWholeWeek(slots: number[] = [20, 22]): Set<string> {
  const monday = startOfWeekMonday(new Date());
  const out = new Set<string>();
  for (let i = 0; i < 7; i += 1) {
    const day = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i);
    for (const slot of slots) out.add(`${toLocalDateStr(day)}:${slot}`);
  }
  return out;
}

/** The week's "N open slots" badge — painted availability minus what is booked. */
function weekOpenSlotCount(): number | null {
  const badge = [...document.querySelectorAll("*")].find(
    (el) => el.children.length === 0 && /^\d+ open slots?$/.test((el.textContent ?? "").trim()),
  );
  const match = /(\d+) open/.exec(badge?.textContent ?? "");
  return match ? Number(match[1]) : null;
}

describe("the detail modal for a CONFIRMED tour", () => {
  it("offers cancel, not move tour date", async () => {
    renderCalendar();
    await openTourModal();

    const labels = modalButtonLabels();
    expect(labels.some((label) => /Move tour date/i.test(label))).toBe(false);
    expect(labels.some((label) => /Cancel tour/i.test(label))).toBe(true);
    expect(labels.filter((label) => /Delete|Cancel tour/i.test(label)).length).toBeGreaterThan(1);
  });

  it("does not delete on the first click — it opens the message popup", async () => {
    renderCalendar();
    await openTourModal();

    fireEvent.click(document.querySelector('[data-attr="tour-delete-open"]')!);

    expect(deletePlannedEvent).not.toHaveBeenCalled();
    expect(cancelFromServer).not.toHaveBeenCalled();
    expect(document.querySelector('[data-attr="portal-notification-confirm"]')).not.toBeNull();
  });

  it("lets the manager back out of a delete", async () => {
    renderCalendar();
    await openTourModal();

    fireEvent.click(document.querySelector('[data-attr="tour-delete-open"]')!);
    const closeButtons = [...document.querySelectorAll('button[aria-label="Close"]')];
    fireEvent.click(closeButtons[closeButtons.length - 1]!);

    expect(deletePlannedEvent).not.toHaveBeenCalled();
    expect(cancelFromServer).not.toHaveBeenCalled();
  });

  it("deletes only after the message popup confirmation", async () => {
    renderCalendar();
    await openTourModal();

    fireEvent.click(document.querySelector('[data-attr="tour-delete-open"]')!);
    await confirmGuestNotificationModal();

    await waitFor(() =>
      expect(cancelFromServer).toHaveBeenCalledWith(expect.objectContaining({ plannedEventId: "planned-1" })),
    );
    expect(deletePlannedEvent).not.toHaveBeenCalled();
  });

  it("cancels through the notifying server route, not a silent local delete", async () => {
    renderCalendar();
    await openTourModal();

    fireEvent.click(document.querySelector('[data-attr="tour-cancel-open"]')!);
    expect(document.body.textContent).toContain("prospect@example.com");
    await confirmGuestNotificationModal();

    await waitFor(() =>
      expect(cancelFromServer).toHaveBeenCalledWith(expect.objectContaining({ plannedEventId: "planned-1" })),
    );
    expect(deletePlannedEvent).not.toHaveBeenCalled();
  });

});

describe("a tour that lives on GOOGLE, not in the planned-events record", () => {
  it("offers no Cancel — the route could only 404", async () => {
    // A Google-sourced tour carries the Google Calendar event id as `sourceId`.
    // The cancel route looks that id up in `axis_admin_planned_events_v1`, where
    // it does not exist, so offering the control at all is a button that can only fail.
    renderCalendar({ meeting: googleSourcedTour() });
    await openTourModal();

    expect(document.querySelector('[data-attr="tour-reschedule-open"]')).toBeNull();
    expect(document.querySelector('[data-attr="tour-cancel-open"]')).toBeNull();
  });

  it("keeps the delete path, which does work for it", async () => {
    renderCalendar({ meeting: googleSourcedTour() });
    await openTourModal();

    expect(document.querySelector('[data-attr="tour-delete-open"]')).not.toBeNull();
    // And still warns that the guest was already told the tour is confirmed.
    fireEvent.click(document.querySelector('[data-attr="tour-delete-open"]')!);
    expect(document.querySelector('[data-attr="tour-delete-confirm"]')!.textContent).toContain(
      "already told this tour is confirmed",
    );
  });
});

/**
 * The two-step arming is right for every deletable meeting, but its wording is
 * not: a manager's own planned event has no guest to keep in the dark, so the
 * confirmation must not ask about one or offer to "Keep tour".
 */
describe("the delete confirmation says what is actually being deleted", () => {
  /** A manager's own calendar event — no guest, no tour. */
  function plannedOwnEvent(): DemoMeeting {
    return {
      ...confirmedTour(),
      id: "planned-own",
      sourceId: "planned-own",
      title: "Audit Prospect block",
      kind: undefined,
      name: "Audit Prospect",
      email: undefined,
    };
  }

  it("uses neutral wording for a manager's own event", async () => {
    renderCalendar({ meeting: plannedOwnEvent() });
    await openTourModal();

    fireEvent.click(document.querySelector('[data-attr="tour-delete-open"]')!);
    const banner = document.querySelector('[data-attr="tour-delete-confirm"]')!;
    expect(banner.textContent).not.toContain("guest");
    expect(banner.textContent).toContain("Delete this event?");
    expect(modalButtonLabels()).toContain("Keep event");
    expect(modalButtonLabels()).not.toContain("Keep tour");
  });

  it("keeps the guest-aware wording for a confirmed tour delete popup", async () => {
    renderCalendar();
    await openTourModal();

    fireEvent.click(document.querySelector('[data-attr="tour-delete-open"]')!);
    expect(document.body.textContent).toContain("Delete tour");
    expect(modalButtonLabels()).not.toContain("Keep tour");
  });

  it("keeps `Delete request` for a pending tour request", async () => {
    renderCalendar({
      meeting: { ...confirmedTour(), id: "inquiry-1", source: "inquiry", sourceId: "inquiry-1" },
    });
    await openTourModal();

    fireEvent.click(document.querySelector('[data-attr="tour-delete-open"]')!);
    expect(document.body.textContent).toContain("Delete tour");
    expect(document.querySelector('[data-attr="portal-notification-confirm"]')).not.toBeNull();
  });
});

/**
 * A cell draws exactly one meeting, and that modal is the only route to its
 * controls. A multi-day Google block now covers every day it spans, so without
 * an explicit precedence it silently replaces a confirmed tour on days 2..N —
 * taking away the Reschedule / Cancel tour this branch exists to add. Invisible
 * in a single-day fixture, which is why this one straddles two.
 */
describe("a multi-day Google block does not swallow a confirmed tour", () => {
  /** Monday 00:00 of the rendered week, and the Tuesday after it. */
  function weekDays() {
    const monday = startOfWeekMonday(new Date());
    const start = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate(), 0, 0, 0, 0);
    const tuesday = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    return { start, tuesday, dayOne: toLocalDateStr(start), dayTwo: toLocalDateStr(tuesday) };
  }

  /** A two-day "Vacation" block: Monday 00:00 through Wednesday 00:00. */
  function multiDayGoogleBlock(start: Date, dayOne: string): DemoMeeting {
    return {
      id: "google_multi",
      source: "external",
      sourceId: "gcal-multi",
      startIso: start.toISOString(),
      endIso: new Date(start.getTime() + 2 * 24 * 60 * 60 * 1000).toISOString(),
      dateStr: dayOne,
      startSlot: 0,
      span: 96,
      durationMinutes: 2880,
      title: "Blocked",
      color: "bg-muted",
      statusLabel: "Blocked",
      googleCalendarPrivate: true,
    };
  }

  /** The confirmed tour at 10 am on the block's SECOND day. */
  function tourOnDayTwo(tuesday: Date, dayTwo: string): DemoMeeting {
    const start = new Date(tuesday.getFullYear(), tuesday.getMonth(), tuesday.getDate(), 10, 0, 0, 0);
    return {
      ...confirmedTour(),
      startIso: start.toISOString(),
      endIso: new Date(start.getTime() + 30 * 60 * 1000).toISOString(),
      dateStr: dayTwo,
    };
  }

  it("still opens the tour, with Cancel tour, on day two", async () => {
    const { start, tuesday, dayOne, dayTwo } = weekDays();
    render(
      <PortalCalendarPanels
        storageKey="axis_mgr_avail_slots_v2_test"
        externalMeetings={[tourOnDayTwo(tuesday, dayTwo), multiDayGoogleBlock(start, dayOne)]}
        scheduleOwnerLabel="Test Manager"
      />,
    );

    await openTourModal();

    const labels = modalButtonLabels();
    expect(labels.some((label) => /Move tour date/i.test(label))).toBe(false);
    expect(labels.some((label) => /Cancel tour/i.test(label))).toBe(true);
  });

  it("still counts the block's day-two half hour as taken", async () => {
    // Precedence decides what a cell DRAWS; it must not change what is open.
    const { start, tuesday, dayOne, dayTwo } = weekDays();
    PAINTED_SLOTS = paintWholeWeek();
    render(
      <PortalCalendarPanels
        storageKey="axis_mgr_avail_slots_v2_test"
        externalMeetings={[tourOnDayTwo(tuesday, dayTwo), multiDayGoogleBlock(start, dayOne)]}
        scheduleOwnerLabel="Test Manager"
      />,
    );

    await waitFor(() => expect(weekOpenSlotCount()).not.toBeNull());
    // 14 painted (2 x 7 days). The block spans Mon 00:00 -> Wed 00:00, taking all
    // four of Mon's and Tue's windows, and the tour sits inside one of Tue's — it
    // must not hand a window back. 12 would mean day two's half hours were still
    // advertised under the block.
    expect(weekOpenSlotCount()).toBe(10);
  });
});

describe("counts stay honest after a tour changes state", () => {
  it("does not count a slot a confirmed tour already occupies as open", async () => {
    const tour = confirmedTour();
    // Two painted windows on the tour's day; the tour consumes one of them.
    PAINTED_SLOTS = paintWholeWeek();

    renderCalendar();
    await waitFor(() => expect(weekOpenSlotCount()).not.toBeNull());

    // 14 painted, and the confirmed tour consumes exactly one. Before the fix this
    // read 14: the booked 10 am window still advertised itself as open, so the
    // calendar over-reported remaining capacity while the public grid had already
    // (correctly) stopped offering that half hour.
    expect(weekOpenSlotCount()).toBe(13);
  });

  it("still draws a Free/declined Google event but does not count it as taken", async () => {
    // Both invariants at once: the manager SEES the event, and the "N open"
    // header agrees with what the public booking page actually offers.
    const tour = confirmedTour();
    PAINTED_SLOTS = paintWholeWeek();

    render(
      <PortalCalendarPanels
        storageKey="axis_mgr_avail_slots_v2_test"
        externalMeetings={[
          {
            ...tour,
            id: "google_free",
            source: "external",
            sourceId: "gcal-free",
            title: "Focus time",
            name: "Focus time",
            blocksTourAvailability: false,
          },
        ]}
        scheduleOwnerLabel="Test Manager"
      />,
    );

    await waitFor(() => expect(weekOpenSlotCount()).not.toBeNull());
    // A Free/declined event blocks nothing, so all 14 painted windows stay open.
    expect(weekOpenSlotCount()).toBe(14);
    expect(
      [...document.querySelectorAll("button")].some((el) => el.textContent?.includes("Focus time")),
    ).toBe(true);
  });

  it("subtracts EVERY day a multi-day event covers, not just the first", async () => {
    // A multi-day / all-day Google event arrives with a ~96-slot span. Marking
    // its slots as `dateStr:startSlot + offset` emitted keys like
    // `2026-08-06:48` that match no cell, so only the first day lost capacity —
    // while the public route, which works in real instants, blocked the whole
    // span. That is the header-vs-public-page disagreement this shape exists to
    // close, so the count has to fall on both days.
    const monday = startOfWeekMonday(new Date());
    const start = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate(), 0, 0, 0, 0);
    const tuesday = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    const dayOne = toLocalDateStr(start);
    const dayTwo = toLocalDateStr(tuesday);
    PAINTED_SLOTS = paintWholeWeek();

    render(
      <PortalCalendarPanels
        storageKey="axis_mgr_avail_slots_v2_test"
        externalMeetings={[
          {
            id: "google_multi",
            source: "external",
            sourceId: "gcal-multi",
            startIso: start.toISOString(),
            endIso: new Date(start.getTime() + 2 * 24 * 60 * 60 * 1000).toISOString(),
            dateStr: dayOne,
            startSlot: 0,
            span: 96,
            durationMinutes: 2880,
            title: "Blocked",
            color: "bg-muted",
            statusLabel: "Blocked",
            googleCalendarPrivate: true,
          },
        ]}
        scheduleOwnerLabel="Test Manager"
      />,
    );

    await waitFor(() => expect(weekOpenSlotCount()).not.toBeNull());
    // 14 painted; the span covers Mon and Tue, so all four of their windows go.
    // 12 is the pre-rollover reading — only the FIRST day lost capacity, while the
    // public route, which works in real instants, blocked the whole span.
    expect(weekOpenSlotCount()).toBe(10);
  });

  it("tells the page around it whenever a tour changes, so tab counts refresh", async () => {
    // Deleting a confirmed tour redrew the grid while the header's view tabs
    // still read "All 1 / Tours 1" until a manual reload.
    const onMeetingsChanged = vi.fn();
    renderCalendar({ onMeetingsChanged });
    await openTourModal();

    fireEvent.click(document.querySelector('[data-attr="tour-delete-open"]')!);
    await confirmGuestNotificationModal();

    await waitFor(() => expect(onMeetingsChanged).toHaveBeenCalled());
  });

  it("pulls the server's planned events back after a cancel", async () => {
    renderCalendar();
    await openTourModal();

    syncScheduleRecords.mockClear();
    fireEvent.click(document.querySelector('[data-attr="tour-cancel-open"]')!);
    confirmGuestNotificationModal();

    await waitFor(() => expect(cancelFromServer).toHaveBeenCalled());
    await waitFor(() => expect(syncScheduleRecords).toHaveBeenCalledWith({ force: true }));
  });


});
