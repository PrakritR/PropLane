/**
 * A confirmed tour can be moved or cancelled, and the guest is told.
 *
 * Confirming a tour used to be a one-way door: the detail modal offered exactly
 * `Close` and `Delete event`, and delete fired with no confirmation, removed the
 * tour instantly, and sent the guest nothing — after PropLane had already
 * emailed them "Your PropLane tour is confirmed". The guest would have travelled
 * to the property.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

let PLANNED_EVENTS: Record<string, unknown>[];
let WRITTEN_PAYLOAD: Record<string, unknown>[] | null;
let READ_ERROR: string | null;

const notifyCanceled = vi.fn(async () => ({ ok: true }));
const notifyRescheduled = vi.fn(async () => ({ ok: true }));
const syncGoogle = vi.fn(async () => null);
const deleteGoogle = vi.fn(async () => undefined);

vi.mock("@/lib/tour-notification-delivery.server", () => ({
  notifyTenantTourCanceled: (...args: unknown[]) => notifyCanceled(...(args as [])),
  notifyTenantTourRescheduled: (...args: unknown[]) => notifyRescheduled(...(args as [])),
}));
vi.mock("@/lib/google-calendar/sync.server", () => ({
  syncPlannedTourToGoogleCalendar: (...args: unknown[]) => syncGoogle(...(args as [])),
  deleteProplaneGoogleCalendarEvent: (...args: unknown[]) => deleteGoogle(...(args as [])),
}));

import { GoogleCalendarNotLinkedError } from "@/lib/google-calendar/api.server";
import { cancelPlannedTour, reschedulePlannedTour } from "@/lib/tour-planned-change.server";

const MANAGER = "mgr-1";

function db() {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () =>
            READ_ERROR
              ? { data: null, error: { message: READ_ERROR } }
              : { data: { row_data: { payload: PLANNED_EVENTS } }, error: null },
        }),
      }),
      upsert: async (rows: { row_data: { payload: Record<string, unknown>[] } }[]) => {
        WRITTEN_PAYLOAD = rows[0]!.row_data.payload;
        return { error: null };
      },
    }),
  } as never;
}

const TOUR = {
  id: "planned-1",
  kind: "tour",
  managerUserId: MANAGER,
  start: "2099-08-06T17:00:00.000Z",
  end: "2099-08-06T17:30:00.000Z",
  slotKey: "2099-08-06:20",
  attendeeName: "Audit Prospect",
  attendeeEmail: "prospect@example.com",
  propertyTitle: "Ballard House",
  googleCalendarEventId: "gcal-1",
};

function expectSoftCanceledTour() {
  expect(WRITTEN_PAYLOAD).toHaveLength(1);
  expect(WRITTEN_PAYLOAD![0]).toMatchObject({
    id: "planned-1",
    canceledAt: expect.stringMatching(/^\d{4}-/),
  });
}

describe("cancelPlannedTour", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    PLANNED_EVENTS = [{ ...TOUR }];
    WRITTEN_PAYLOAD = null;
    READ_ERROR = null;
  });

  it("soft-cancels the tour and notifies the guest", async () => {
    const result = await cancelPlannedTour(db(), {
      plannedEventId: "planned-1",
      actorUserId: MANAGER,
      notifyGuest: true,
      reason: "Unit is no longer available",
    });

    expect(result.ok).toBe(true);
    expectSoftCanceledTour();
    expect(notifyCanceled).toHaveBeenCalledTimes(1);
    // The guest-facing reason reaches the notification, not just the audit log.
    expect(notifyCanceled.mock.calls[0]![4]).toBe("Unit is no longer available");
  });

  it("removes the manager's Google Calendar entry too", async () => {
    await cancelPlannedTour(db(), { plannedEventId: "planned-1", actorUserId: MANAGER, notifyGuest: true });
    expect(deleteGoogle).toHaveBeenCalledWith(expect.anything(), MANAGER, "gcal-1");
  });

  it("waits for the Google delete rather than firing it and returning", async () => {
    // Fire-and-forget let a serverless instance freeze before the delete landed,
    // stranding a ghost event that keeps blocking the slot this cancel freed —
    // public availability now subtracts Google busy time.
    let settled = false;
    deleteGoogle.mockImplementationOnce(async () => {
      await Promise.resolve();
      settled = true;
      return undefined;
    });
    const result = await cancelPlannedTour(db(), {
      plannedEventId: "planned-1",
      actorUserId: MANAGER,
      notifyGuest: true,
    });
    expect(settled).toBe(true);
    expect(result).toMatchObject({ ok: true, calendarSync: { ok: true } });
  });

  it("still cancels when Google fails, and says so on the result", async () => {
    deleteGoogle.mockRejectedValueOnce(new Error("calendar revoked"));
    const result = await cancelPlannedTour(db(), {
      plannedEventId: "planned-1",
      actorUserId: MANAGER,
      notifyGuest: true,
    });
    // The PropLane-side cancel already happened and the guest was told; a Google
    // failure is reported, never turned into a failed cancel.
    expect(result).toMatchObject({ ok: true, calendarSync: { ok: false, error: "calendar revoked" } });
    expectSoftCanceledTour();
    expect(notifyCanceled).toHaveBeenCalledTimes(1);
  });

  it("treats a disconnected calendar as skipped, not as a failure", async () => {
    // The delete path THROWS for this state while the reschedule path quietly
    // returns null. Warning "your Google Calendar did not update" on cancel and
    // saying nothing on reschedule, for the identical state, is unactionable.
    deleteGoogle.mockRejectedValueOnce(new GoogleCalendarNotLinkedError("Google Calendar is not connected."));
    const result = await cancelPlannedTour(db(), {
      plannedEventId: "planned-1",
      actorUserId: MANAGER,
      notifyGuest: true,
    });
    expect(result).toMatchObject({ ok: true, calendarSync: { ok: true, skipped: true } });
  });

  it("treats an unconfigured integration as skipped too", async () => {
    deleteGoogle.mockRejectedValueOnce(new GoogleCalendarNotLinkedError("Google Calendar is not configured."));
    const result = await cancelPlannedTour(db(), {
      plannedEventId: "planned-1",
      actorUserId: MANAGER,
      notifyGuest: true,
    });
    expect(result).toMatchObject({ ok: true, calendarSync: { ok: true, skipped: true } });
  });

  it("does not hang the response on a Google call that never settles", async () => {
    // The PropLane write already committed and the guest email already went
    // out, so holding the response to the platform timeout — which the client
    // reports as "could not reach the server" — is worse than a warning.
    vi.useFakeTimers();
    try {
      deleteGoogle.mockImplementationOnce(() => new Promise(() => {}));
      const pending = cancelPlannedTour(db(), {
        plannedEventId: "planned-1",
        actorUserId: MANAGER,
        notifyGuest: true,
      });
      await vi.advanceTimersByTimeAsync(30_000);
      const result = await pending;
      expect(result).toMatchObject({ ok: true, calendarSync: { ok: false } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a skipped sync for a tour that was never on Google", async () => {
    PLANNED_EVENTS = [{ ...TOUR, googleCalendarEventId: undefined }];
    const result = await cancelPlannedTour(db(), {
      plannedEventId: "planned-1",
      actorUserId: MANAGER,
      notifyGuest: true,
    });
    expect(result).toMatchObject({ ok: true, calendarSync: { ok: true, skipped: true } });
    expect(deleteGoogle).not.toHaveBeenCalled();
  });

  it("refuses another manager's tour", async () => {
    const result = await cancelPlannedTour(db(), {
      plannedEventId: "planned-1",
      actorUserId: "someone-else",
      notifyGuest: true,
    });
    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(WRITTEN_PAYLOAD).toBeNull();
    expect(notifyCanceled).not.toHaveBeenCalled();
  });

  it("reports a failed read as a failure, never as an already-deleted tour", async () => {
    READ_ERROR = "connection reset";
    const result = await cancelPlannedTour(db(), {
      plannedEventId: "planned-1",
      actorUserId: MANAGER,
      notifyGuest: true,
    });
    // A 404 here would tell the manager the tour is gone while it is still on
    // the calendar and the guest still expects it.
    expect(result).toMatchObject({ ok: false, status: 500 });
  });

  it("does not notify when the manager explicitly opts out", async () => {
    await cancelPlannedTour(db(), {
      plannedEventId: "planned-1",
      actorUserId: MANAGER,
      notifyGuest: false,
    });
    expectSoftCanceledTour();
    expect(notifyCanceled).not.toHaveBeenCalled();
  });
});

describe("reschedulePlannedTour", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    PLANNED_EVENTS = [{ ...TOUR }];
    WRITTEN_PAYLOAD = null;
    READ_ERROR = null;
  });

  const NEW_START = "2099-08-07T18:00:00.000Z";
  const NEW_END = "2099-08-07T18:30:00.000Z";

  it("moves the tour and tells the guest both times", async () => {
    const result = await reschedulePlannedTour(db(), {
      plannedEventId: "planned-1",
      actorUserId: MANAGER,
      start: NEW_START,
      end: NEW_END,
      notifyGuest: true,
    });

    expect(result.ok).toBe(true);
    expect(WRITTEN_PAYLOAD![0]).toMatchObject({ id: "planned-1", start: NEW_START, end: NEW_END });
    expect(notifyRescheduled).toHaveBeenCalledTimes(1);
    expect(notifyRescheduled.mock.calls[0]![3]).toMatchObject({
      window: { start: NEW_START, end: NEW_END },
      previousWindow: { start: TOUR.start, end: TOUR.end },
    });
  });

  it("drops the stale slotKey so the old window is not still blocked", async () => {
    // The slotKey named the OLD half hour. Carrying it forward would leave the
    // new window bookable and the old one blocked in the public grid — the
    // exact double-booking shape this sweep closes.
    await reschedulePlannedTour(db(), {
      plannedEventId: "planned-1",
      actorUserId: MANAGER,
      start: NEW_START,
      end: NEW_END,
      notifyGuest: true,
    });
    expect(WRITTEN_PAYLOAD![0]!.slotKey).toBeUndefined();
  });

  it("moves the Google Calendar entry instead of creating a second one", async () => {
    await reschedulePlannedTour(db(), {
      plannedEventId: "planned-1",
      actorUserId: MANAGER,
      start: NEW_START,
      end: NEW_END,
      notifyGuest: true,
    });
    expect(syncGoogle.mock.calls[0]![2]).toMatchObject({ googleCalendarEventId: "gcal-1" });
  });

  it("waits for the Google move, and reports a failure without failing the reschedule", async () => {
    syncGoogle.mockRejectedValueOnce(new Error("calendar revoked"));
    const result = await reschedulePlannedTour(db(), {
      plannedEventId: "planned-1",
      actorUserId: MANAGER,
      start: NEW_START,
      end: NEW_END,
      notifyGuest: true,
    });
    expect(result).toMatchObject({ ok: true, calendarSync: { ok: false, error: "calendar revoked" } });
    expect(WRITTEN_PAYLOAD![0]).toMatchObject({ start: NEW_START, end: NEW_END });
  });

  it("refuses a window another confirmed tour already occupies", async () => {
    PLANNED_EVENTS = [
      { ...TOUR },
      { id: "planned-2", kind: "tour", managerUserId: MANAGER, start: NEW_START, end: NEW_END },
    ];
    const result = await reschedulePlannedTour(db(), {
      plannedEventId: "planned-1",
      actorUserId: MANAGER,
      start: NEW_START,
      end: NEW_END,
      notifyGuest: true,
    });
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(WRITTEN_PAYLOAD).toBeNull();
    expect(notifyRescheduled).not.toHaveBeenCalled();
  });

  it("rejects an end at or before the start", async () => {
    const result = await reschedulePlannedTour(db(), {
      plannedEventId: "planned-1",
      actorUserId: MANAGER,
      start: NEW_END,
      end: NEW_START,
      notifyGuest: true,
    });
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(WRITTEN_PAYLOAD).toBeNull();
  });

  it("refuses another manager's tour", async () => {
    const result = await reschedulePlannedTour(db(), {
      plannedEventId: "planned-1",
      actorUserId: "someone-else",
      start: NEW_START,
      end: NEW_END,
      notifyGuest: true,
    });
    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(WRITTEN_PAYLOAD).toBeNull();
  });
});
