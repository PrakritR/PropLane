// @vitest-environment jsdom
//
// Two manager-calendar findings that both come down to "the screen you act on
// disagrees with the screen beside it":
//
//  F-CAL-1 — the day headers read "9 EVENTS" while the view tabs immediately
//  above read "All 0", because the headers counted linked-Google busy blocks
//  and the tabs counted tours + service orders.
//
//  F-CAL-6 — the PER-PROPERTY availability calendar, the screen where a manager
//  publishes tour windows, rendered no busy overlay at all, so a half hour the
//  portfolio calendar showed as "Blocked" was a free, selectable slot there.
//  Publishing on top of it is a double-booking.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { DemoMeeting } from "@/components/portal/portal-calendar-panels";
import { scheduledCalendarMeetings } from "@/lib/google-calendar/meetings";

const capturedProps: Record<string, unknown>[] = [];

// The tour panel navigates now, so it calls useRouter — which throws outside an app router.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  usePathname: () => "/portal/properties/listed",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/portal/portal-calendar-panels", () => ({
  PortalCalendarPanels: (props: Record<string, unknown>) => {
    capturedProps.push(props);
    return null;
  },
}));
// Spread the real module and override only the section shell. A hand-listed
// mock silently takes the whole file down the moment the module grows an export
// the component imports — which is what `PropertyDetailFooterActions` did.
vi.mock("@/components/portal/portal-property-detail-section", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/portal/portal-property-detail-section")>()),
  PortalPropertyDetailSection: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/portal/share-lead-link-modal", () => ({
  ShareLeadLinkModal: () => null,
}));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast: () => {} }),
}));
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => () => {} }));

function meeting(over: Partial<DemoMeeting>): DemoMeeting {
  return {
    id: "m1",
    dateStr: "2026-08-03",
    startSlot: 15,
    endSlot: 16,
    title: "Busy",
    source: "external",
    sourceId: "g1",
    startIso: "2026-08-03T07:30:00.000Z",
    ...over,
  } as DemoMeeting;
}

afterEach(() => {
  capturedProps.length = 0;
  cleanup();
  vi.unstubAllGlobals();
});

/** Availability grid opens in the tour availability modal. */
async function renderTourAvailabilityModal(options: {
  managerUserId: string | null;
  showToast?: (message: string) => void;
}) {
  const { ManagerTourAvailabilityModal } = await import(
    "@/components/portal/manager-tour-availability-modal"
  );
  render(
    <ManagerTourAvailabilityModal
      open
      onClose={() => {}}
      managerUserId={options.managerUserId}
      propertyId="mgr-demo-ballard"
      propertyLabel="Ballard House"
      showToast={options.showToast ?? (() => {})}
    />,
  );
  if (options.managerUserId) {
    await waitFor(() => expect(capturedProps.length).toBeGreaterThan(0));
  }
}

describe("day-header event counts (F-CAL-1)", () => {
  it("counts what the view tabs count — tours and service visits, not Google busy", () => {
    const meetings = [
      meeting({ id: "busy-1", googleCalendarPrivate: true }),
      meeting({ id: "busy-2", googleCalendarPrivate: true }),
      meeting({ id: "tour-1", source: "planned", kind: "tour", googleCalendarPrivate: false }),
    ];
    expect(scheduledCalendarMeetings(meetings).map((m) => m.id)).toEqual(["tour-1"]);
  });

  it("a week of nothing but busy blocks counts zero events, matching 'All 0'", () => {
    const busyWeek = Array.from({ length: 9 }, (_, i) =>
      meeting({ id: `busy-${i}`, googleCalendarPrivate: true }),
    );
    expect(scheduledCalendarMeetings(busyWeek)).toHaveLength(0);
  });

  it("keeps a Google-sourced TOUR — only personal busy time is excluded", () => {
    const tourFromGoogle = meeting({ id: "g-tour", kind: "tour", googleCalendarPrivate: false });
    expect(scheduledCalendarMeetings([tourFromGoogle])).toHaveLength(1);
  });
});

describe("property availability calendar shows the same conflicts (F-CAL-6)", () => {
  it("passes linked-Google busy time into the per-property calendar", async () => {
    const busy = meeting({ id: "busy-1", googleCalendarPrivate: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ meetings: [busy] }) })),
    );
    await renderTourAvailabilityModal({ managerUserId: "m1" });
    await waitFor(() => {
      const latest = capturedProps.at(-1);
      expect((latest?.externalMeetings as DemoMeeting[] | undefined)?.map((m) => m.id)).toEqual(["busy-1"]);
    });
  });

  it("asks for a window wide enough that navigating a few weeks out still shows conflicts", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ meetings: [] }) }));
    vi.stubGlobal("fetch", fetchMock);
    const { GOOGLE_BUSY_DEFAULT_DAYS_AHEAD, GOOGLE_BUSY_DAYS_BEFORE } = await import(
      "@/hooks/use-google-calendar-busy"
    );
    await renderTourAvailabilityModal({ managerUserId: "m1" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const url = new URL(String(fetchMock.mock.calls[0]![0]), "https://example.test");
    const timeMin = new Date(url.searchParams.get("timeMin")!);
    const timeMax = new Date(url.searchParams.get("timeMax")!);
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;

    // Starts before today, so this week is never clipped at "now"…
    expect(timeMin.getTime()).toBeLessThan(now);
    // …and reaches far enough forward that the two-week blind spot is gone.
    //
    // The window starts at the top of LAST week, so how far past "now" it
    // reaches depends on the weekday: the full 56 days on a Monday, shrinking
    // to just over 49 by Sunday night. A flat `> 50` therefore failed every
    // Sunday CI run (measured 49.93) while passing the rest of the week.
    // Assert the guaranteed floor derived from the constants instead.
    expect(GOOGLE_BUSY_DEFAULT_DAYS_AHEAD).toBeGreaterThanOrEqual(56);
    const reachDays = (timeMax.getTime() - now) / day;
    expect(reachDays).toBeGreaterThan(GOOGLE_BUSY_DEFAULT_DAYS_AHEAD - GOOGLE_BUSY_DAYS_BEFORE);
    expect(reachDays).toBeLessThanOrEqual(GOOGLE_BUSY_DEFAULT_DAYS_AHEAD);
  });

  it("asks Google for nothing when there is no signed-in manager", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ meetings: [] }) }));
    vi.stubGlobal("fetch", fetchMock);
    await renderTourAvailabilityModal({ managerUserId: null });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(capturedProps.at(-1)?.storageKey).toBeNull();
  });
});

/**
 * A busy grid that could not be fully loaded looks exactly like a free one, and
 * this is the screen where availability is PUBLISHED — so incompleteness has to
 * reach the manager here, not only on /portal/calendar which they may never
 * open. Connection SETUP problems stay with the portfolio calendar so the same
 * account-level problem is not toasted twice.
 */
describe("an incomplete busy read is never presented as a free calendar", () => {
  async function renderAvailabilityModal() {
    const toasts: string[] = [];
    await renderTourAvailabilityModal({
      managerUserId: "m1",
      showToast: (message: string) => toasts.push(message),
    });
    return toasts;
  }

  it("tells the manager when the response was truncated", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          meetings: [meeting({ id: "busy-1", googleCalendarPrivate: true })],
          truncated: true,
          warning: "calendar_events_truncated",
          hint: "Some busy time may be missing.",
        }),
      })),
    );

    const toasts = await renderAvailabilityModal();
    await waitFor(() => expect(toasts).toEqual(["Some busy time may be missing."]));
    // The events it DID load still reach the grid.
    expect((capturedProps.at(-1)?.externalMeetings as DemoMeeting[]).map((m) => m.id)).toEqual(["busy-1"]);
  });

  it("tells the manager when the read failed outright", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: "Failed" }) })),
    );

    const toasts = await renderAvailabilityModal();
    await waitFor(() => expect(toasts).toHaveLength(1));
    expect(toasts[0]).toMatch(/could not load/i);
  });

  it("does not believe a 200 that carries no meetings list", async () => {
    // An edge or proxy error page is an HTML 200 — parsing to nothing is not
    // evidence that the calendar is free.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => {
          throw new Error("Unexpected token < in JSON");
        },
      })),
    );

    const toasts = await renderAvailabilityModal();
    await waitFor(() => expect(toasts).toHaveLength(1));
    expect(toasts[0]).toMatch(/could not load/i);
  });

  it("does not believe a 200 whose body omits the meetings array", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({}) })),
    );

    const toasts = await renderAvailabilityModal();
    await waitFor(() => expect(toasts).toHaveLength(1));
    expect(toasts[0]).toMatch(/could not load/i);
  });

  it("tells the manager when the request never completed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );

    const toasts = await renderAvailabilityModal();
    await waitFor(() => expect(toasts).toHaveLength(1));
    expect(toasts[0]).toMatch(/could not load/i);
  });

  it("leaves the connection-setup warnings to the portfolio calendar", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          meetings: [],
          warning: "calendar_not_connected",
          hint: "Google Calendar is not linked yet.",
        }),
      })),
    );

    const toasts = await renderAvailabilityModal();
    await waitFor(() => expect(capturedProps.length).toBeGreaterThan(0));
    expect(toasts).toEqual([]);
  });

  it("classifies incompleteness by code, so both calendars agree on what to surface", async () => {
    const {
      GOOGLE_BUSY_TRUNCATED_WARNING,
      GOOGLE_BUSY_UNAVAILABLE_WARNING,
      isGoogleBusyIncompleteWarning,
    } = await import("@/hooks/use-google-calendar-busy");

    expect(isGoogleBusyIncompleteWarning(GOOGLE_BUSY_TRUNCATED_WARNING)).toBe(true);
    expect(isGoogleBusyIncompleteWarning(GOOGLE_BUSY_UNAVAILABLE_WARNING)).toBe(true);
    expect(isGoogleBusyIncompleteWarning("calendar_not_connected")).toBe(false);
    expect(isGoogleBusyIncompleteWarning("calendar_api_disabled")).toBe(false);
    expect(isGoogleBusyIncompleteWarning("calendar_oauth_not_configured")).toBe(false);
    expect(isGoogleBusyIncompleteWarning(undefined)).toBe(false);
  });
});
