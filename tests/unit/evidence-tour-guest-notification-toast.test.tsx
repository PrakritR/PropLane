// @vitest-environment jsdom
/**
 * What the MANAGER is told after cancelling a confirmed tour.
 *
 * The guest was already emailed "Your PropLane tour is confirmed", so the only
 * thing that matters after a change is whether they heard about it. Reporting
 * "the guest was notified" when the send failed is the one outcome a manager
 * cannot recover from — they close the modal believing the prospect knows.
 *
 * `tourGuestNotificationFailed` is the single read of that question, and the
 * two shapes it has to separate are easy to conflate:
 *
 *   - `{ ok: true, error: "…" }`   a send that ERRORED but still reads ok
 *   - `{ ok: true, skipped: true }` deliberately not sent (sandbox address, no
 *                                   mail provider) — not a failure
 *
 * This drives the real calendar panel, so what it asserts is the toast string
 * a manager actually reads.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { PortalCalendarPanels, type DemoMeeting } from "@/components/portal/portal-calendar-panels";

type ChangeResult = {
  ok: boolean;
  guestNotification?: { ok: boolean; skipped?: boolean; error?: string } | null;
  calendarSync?: { ok: boolean; skipped?: boolean; error?: string } | null;
};

let CANCEL_RESULT: ChangeResult = { ok: true };
const toasts: string[] = [];

vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast: (message: string) => void toasts.push(message) }),
}));
vi.mock("next/navigation", () => ({
  // A whole-module mock must name every export the tree reaches, or the first
  // component to call a missing one fails the render with a generic error.
  usePathname: () => "/portal/tours",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
}));

// Opening the tour modal now mounts the tour-reminder panel, which fetches on
// mount. Unstubbed, that relative URL cannot be parsed under node, the panel
// toasts its failure, and `toasts.at(-1)` below reads THAT instead of the
// cancellation result this file is about.
vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
  const url = String(input);
  const body = url.includes("/api/portal/tour-reminders") ? { reminder: null } : {};
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});
vi.mock("@/lib/tour-planned-change.client", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    cancelPlannedTourFromServer: async () => CANCEL_RESULT,
  };
});
vi.mock("@/lib/google-calendar/delete-tour.client", () => ({
  deleteProplaneGoogleTourFromServer: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/rental-application/data", () => ({ getPropertyById: () => undefined }));
vi.mock("@/lib/manager-calendar-tour-meetings", () => ({ buildScheduledTourMeetings: () => [] }));
vi.mock("@/lib/demo-admin-scheduling", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    syncScheduleRecordsFromServer: vi.fn(async () => undefined),
    readAvailabilityDateSetForStorageKey: () => new Set<string>(),
    readPlannedEvents: () => [],
    deletePlannedEventFromServer: vi.fn(async () => true),
    deletePartnerInquiryFromServer: vi.fn(async () => true),
    acceptPartnerInquiryFromServer: vi.fn(async () => ({ ok: true })),
    writeAvailabilityDateSetForStorageKeyToServer: vi.fn(async () => true),
  };
});

/** A confirmed tour on today's calendar, the shape the grid renders. */
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

/** Confirm the open guest-notification compose popup. */
async function confirmGuestNotificationModal() {
  const btn = await waitFor(() => {
    const el = document.querySelector('[data-attr="portal-notification-confirm"]') as HTMLButtonElement | null;
    if (!el || el.disabled) throw new Error("confirm not ready");
    return el;
  });
  fireEvent.click(btn);
}

async function openTourModal() {
  render(
    <PortalCalendarPanels
      storageKey="axis_mgr_avail_slots_v2_guest_notice"
      externalMeetings={[confirmedTour()]}
      scheduleOwnerLabel="Test Manager"
    />,
  );
  const cell = await waitFor(() => {
    const hit = [...document.querySelectorAll("button")].find((el) => el.textContent?.includes("Audit Prospect"));
    if (!hit) throw new Error("tour cell not rendered");
    return hit;
  });
  fireEvent.click(cell);
  await waitFor(() => {
    if (!document.querySelector(".modal-panel")) throw new Error("modal not open");
  });
}

/** Cancel the open tour and return the toast the manager reads. */
async function cancelAndReadToast(result: ChangeResult): Promise<string> {
  CANCEL_RESULT = result;
  await openTourModal();
  fireEvent.click(document.querySelector('[data-attr="tour-cancel-open"]')!);
  await confirmGuestNotificationModal();
  return await waitFor(() => {
    const last = toasts.at(-1);
    if (!last) throw new Error("no toast yet");
    return last;
  });
}


afterEach(cleanup);
beforeEach(() => {
  toasts.length = 0;
  CANCEL_RESULT = { ok: true };
});

describe("cancelling a confirmed tour reports the guest notification honestly", () => {
  it("says the guest could not be notified when the send reports a failure", async () => {
    expect(await cancelAndReadToast({ ok: true, guestNotification: { ok: false, error: "Resend 403" } })).toBe(
      "Tour cancelled, but the guest could not be notified.",
    );
  });

  it("says the same when the send ERRORED but still carried ok: true", async () => {
    // The shape this fix exists for: the server used to answer `{ ok: true,
    // skipped: true, error }` for a failed email, which the panel read as
    // success and told the manager the guest had been notified.
    expect(
      await cancelAndReadToast({
        ok: true,
        guestNotification: { ok: true, error: "550 mailbox unavailable" },
      }),
    ).toBe("Tour cancelled, but the guest could not be notified.");
  });

  it("still claims success for a deliberate skip", async () => {
    expect(await cancelAndReadToast({ ok: true, guestNotification: { ok: true, skipped: true } })).toBe(
      "Tour cancelled and the guest was notified.",
    );
  });

  it("reports a Google Calendar miss separately from a guest miss", async () => {
    expect(
      await cancelAndReadToast({
        ok: true,
        guestNotification: { ok: true },
        calendarSync: { ok: false, error: "token expired" },
      }),
    ).toBe("Tour cancelled and the guest was notified, but your Google Calendar did not update.");
  });
});
