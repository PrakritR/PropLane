/**
 * PRP-397 — the two-way Google link on CONFIRM.
 *
 * Cancel and reschedule already AWAIT their Google push, for a reason spelled
 * out in `tour-planned-change.server.ts`: a serverless instance can be frozen
 * the moment the response goes out, so a fire-and-forget push may never run.
 * Confirm had the mirror gap — `void syncPlannedTourToGoogleCalendar(...)` — so
 * a tour PropLane had already emailed the guest about could be missing from the
 * manager's own calendar. Both confirm paths now wait on the same bounded,
 * classified helper and report the outcome instead of swallowing it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const syncGoogle = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => "gcal-new");

vi.mock("@/lib/tour-notifications", () => ({
  notifyTenantTourConfirmed: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/tour-notification-delivery.server", () => ({
  notifyTenantTourConfirmed: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/google-calendar/sync.server", () => ({
  syncPlannedTourToGoogleCalendar: (...args: unknown[]) => syncGoogle(...args),
}));
vi.mock("@/lib/manager-default-tasks.server", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createPrepareForTourTask: vi.fn(async () => undefined),
}));

import { GoogleCalendarNotLinkedError } from "@/lib/google-calendar/api.server";
import { runPlannedTourCalendarSync } from "@/lib/google-calendar/planned-tour-sync.server";
import { confirmTourInquiry } from "@/lib/tour-inquiry-confirm.server";
import { acceptTourInquiry } from "@/lib/tour-inquiry.server";

const INQUIRIES_RECORD_ID = "axis_admin_partner_inquiries_v1";
const PLANNED_RECORD_ID = "axis_admin_planned_events_v1";

const MANAGER = "mgr-owner";
const START = "2099-08-06T17:00:00.000Z";
const END = "2099-08-06T18:00:00.000Z";

function inquiry(over: Record<string, unknown> = {}) {
  return {
    id: "inq-1",
    kind: "tour",
    status: "pending",
    name: "Guest",
    email: "guest@example.com",
    phone: "2065550123",
    smsConsent: true,
    managerUserId: MANAGER,
    eligibleHostUserIds: [MANAGER],
    propertyId: "prop-1",
    propertyTitle: "Ballard House",
    proposedStart: START,
    proposedEnd: END,
    requestedWindows: [{ start: START, end: END, slotKey: "2099-08-06:34", managerUserId: MANAGER }],
    ...over,
  };
}

function makeDb() {
  const written: { planned: Record<string, unknown>[] } = { planned: [] };
  const db = {
    from: () => ({
      select: () => ({
        eq: (_column: string, id: string) => ({
          maybeSingle: async () => ({
            data: {
              row_data: {
                payload: id === INQUIRIES_RECORD_ID ? [inquiry()] : [],
              },
            },
            error: null,
          }),
        }),
      }),
      upsert: async (rows: Record<string, unknown> | Record<string, unknown>[]) => {
        for (const row of Array.isArray(rows) ? rows : [rows]) {
          if (row.id !== PLANNED_RECORD_ID) continue;
          const data = row.row_data as { payload?: Record<string, unknown>[] };
          written.planned = data.payload ?? [];
        }
        return { error: null };
      },
      delete: () => ({ in: async () => ({ error: null }) }),
    }),
  };
  return { db: db as never, written };
}

beforeEach(() => {
  vi.clearAllMocks();
  syncGoogle.mockImplementation(async () => "gcal-new");
});

describe("confirmTourInquiry pushes the tour to Google before answering", () => {
  it("waits for the push and reports it on the result", async () => {
    let pushSettled = false;
    syncGoogle.mockImplementationOnce(
      () =>
        new Promise((resolve) =>
          setTimeout(() => {
            pushSettled = true;
            resolve("gcal-new");
          }, 20),
        ),
    );
    const { db, written } = makeDb();

    const result = await confirmTourInquiry(db, { inquiryId: "inq-1", actorUserId: MANAGER, notifyTenant: false });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The response did not go out before Google had the event.
    expect(pushSettled).toBe(true);
    expect(result.calendarSync).toEqual({ ok: true });
    expect(syncGoogle).toHaveBeenCalledTimes(1);
    const [, managerUserId, event] = syncGoogle.mock.calls[0] as [unknown, string, Record<string, unknown>];
    expect(managerUserId).toBe(MANAGER);
    expect(event).toMatchObject({
      plannedEventId: String(written.planned.at(-1)?.id),
      start: START,
      end: END,
      attendeeName: "Guest",
      attendeeEmail: "guest@example.com",
    });
    expect(written.planned.at(-1)).toMatchObject({ smsConsent: true, attendeePhone: "2065550123" });
  });

  it("books the tour and reports a Google failure rather than failing the confirm", async () => {
    syncGoogle.mockRejectedValueOnce(new Error("calendar revoked"));
    const { db, written } = makeDb();

    const result = await confirmTourInquiry(db, { inquiryId: "inq-1", actorUserId: MANAGER, notifyTenant: false });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(written.planned).toHaveLength(1);
    expect(result.calendarSync).toEqual({ ok: false, error: "calendar revoked" });
  });

  it("reports an unlinked calendar as skipped, not as a failure", async () => {
    syncGoogle.mockRejectedValueOnce(new GoogleCalendarNotLinkedError("Google Calendar is not connected."));
    const { db } = makeDb();

    const result = await confirmTourInquiry(db, { inquiryId: "inq-1", actorUserId: MANAGER, notifyTenant: false });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.calendarSync).toEqual({ ok: true, skipped: true });
  });
});

describe("acceptTourInquiry (the calendar tool's path) waits the same way", () => {
  it("awaits the push and carries the outcome", async () => {
    let pushSettled = false;
    syncGoogle.mockImplementationOnce(
      () =>
        new Promise((resolve) =>
          setTimeout(() => {
            pushSettled = true;
            resolve("gcal-new");
          }, 20),
        ),
    );
    const { db } = makeDb();

    const result = await acceptTourInquiry(db, MANAGER, { inquiryId: "inq-1" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(pushSettled).toBe(true);
    expect(result.calendarSync).toEqual({ ok: true });
  });

  it("reports a Google failure without failing the accept", async () => {
    syncGoogle.mockRejectedValueOnce(new Error("quota exceeded"));
    const { db } = makeDb();

    const result = await acceptTourInquiry(db, MANAGER, { inquiryId: "inq-1" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.calendarSync).toEqual({ ok: false, error: "quota exceeded" });
  });
});

describe("runPlannedTourCalendarSync", () => {
  it("classifies a synchronous throw the same as a rejected promise", async () => {
    const result = await runPlannedTourCalendarSync(() => {
      throw new Error("boom");
    });
    expect(result).toEqual({ ok: false, error: "boom" });
  });

  it("gives up on a push that never settles instead of hanging the confirm", async () => {
    vi.useFakeTimers();
    try {
      const pending = runPlannedTourCalendarSync(() => new Promise(() => {}));
      await vi.runAllTimersAsync();
      await expect(pending).resolves.toEqual({
        ok: false,
        error: "Google Calendar did not respond in time.",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
