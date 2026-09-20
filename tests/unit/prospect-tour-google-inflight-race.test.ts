import { beforeEach, describe, expect, it, vi } from "vitest";

const google = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  connection: vi.fn(),
}));

vi.mock("@/lib/google-calendar/api.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/google-calendar/api.server")>()),
  createGoogleCalendarEvent: google.create,
  updateGoogleCalendarEvent: google.update,
  deleteGoogleCalendarEvent: google.remove,
}));
vi.mock("@/lib/google-calendar/settings", () => ({ loadGoogleCalendarConnection: google.connection }));
vi.mock("@/lib/agent-notify.server", () => ({ notifyAgent: vi.fn() }));
vi.mock("@/lib/sms/owner-sms-dispatcher.server", () => ({ dispatchOwnerSms: vi.fn() }));

import { syncPlannedTourToGoogleCalendar } from "@/lib/google-calendar/sync.server";
import {
  recoverExpiredProspectTourGoogleCalendarCreates,
  recoverPendingProspectTourGoogleCalendarCleanup,
} from "@/lib/prospect-tour-booking-recovery.server";

describe("in-flight Google create cancellation recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    google.connection.mockResolvedValue({ connected: true, syncEnabled: true });
  });

  it("cannot finish a 404 cleanup while create is pending and removes the remote id after a crash", async () => {
    const managerUserId = "11111111-1111-4111-8111-111111111111";
    const plannedEventId = "planned-paused-create-1";
    const generation = "00000000-0000-4000-8000-000000000321";
    const deterministicId = "a".repeat(64);
    let resolveProvider!: (id: string) => void;
    const providerSink = new Promise<string>((resolve) => { resolveProvider = resolve; });
    google.create.mockReturnValue(providerSink);
    google.remove.mockResolvedValue(undefined);

    let cancelled = false;
    let expired = false;
    let reconciliationCount = 0;
    let secondSweepReady = false;
    let cleanupClaimed = false;
    let persistReached = false;
    const neverPersist = new Promise<never>(() => undefined);
    const rpc = vi.fn(async (name: string) => {
      if (name === "begin_prospect_tour_google_calendar_write") {
        return { data: { allowed: true, generation, googleCalendarEventId: deterministicId }, error: null };
      }
      if (name === "persist_confirmed_tour_google_calendar_id") {
        persistReached = true;
        // Simulate process death after Google accepted the insert but before
        // local metadata could commit. The abandoned promise never settles.
        return neverPersist;
      }
      if (name === "claim_prospect_tour_google_calendar_create_reconciliation") {
        if (!expired || reconciliationCount > (secondSweepReady ? 1 : 0)) return { data: [], error: null };
        return {
          data: [{
            planned_event_id: plannedEventId,
            manager_user_id: managerUserId,
            google_calendar_event_id: deterministicId,
            generation,
          }],
          error: null,
        };
      }
      if (name === "complete_prospect_tour_google_calendar_create_reconciliation") {
        reconciliationCount += 1;
        return { data: true, error: null };
      }
      if (name === "claim_prospect_tour_google_calendar_cleanup") {
        if (reconciliationCount === 0 || cleanupClaimed) return { data: [], error: null };
        cleanupClaimed = true;
        return {
          data: [{
            planned_event_id: plannedEventId,
            manager_user_id: managerUserId,
            google_calendar_event_id: deterministicId,
          }],
          error: null,
        };
      }
      if (name === "complete_prospect_tour_google_calendar_cleanup") {
        return { data: true, error: null };
      }
      return { data: null, error: null };
    });
    const db = {
      rpc,
      from() {
        const query: Record<string, unknown> = {};
        const self = () => query;
        query.select = self;
        query.eq = self;
        query.update = self;
        query.maybeSingle = async () => ({
          data: { row_data: { payload: cancelled ? [] : [{ id: plannedEventId }] } },
          error: null,
        });
        query.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve);
        return query;
      },
    };

    void syncPlannedTourToGoogleCalendar(db as never, managerUserId, {
      plannedEventId,
      title: "Tour",
      start: "2099-11-09T17:00:00.000Z",
      end: "2099-11-09T17:30:00.000Z",
    });
    await vi.waitFor(() => expect(google.create).toHaveBeenCalledOnce());

    // Cancellation commits while the provider request is paused. The cleanup
    // worker's modeled 404 cannot become terminal because the intent is live.
    cancelled = true;
    expect((await rpc("claim_prospect_tour_google_calendar_cleanup")).data).toEqual([]);

    // The lease can expire and the first reconciliation can observe a 404
    // while the original provider create is still capable of committing.
    expired = true;
    await expect(recoverExpiredProspectTourGoogleCalendarCreates(db as never)).resolves.toEqual({
      scanned: 1,
      reconciled: 1,
      failed: 0,
    });
    expect(google.remove).toHaveBeenCalledTimes(1);

    // The provider commits after that 404 and the worker dies before local
    // settlement. The durable tombstone is reclaimed for a later delete.
    resolveProvider(deterministicId);
    await vi.waitFor(() => expect(persistReached).toBe(true));
    secondSweepReady = true;
    await expect(recoverExpiredProspectTourGoogleCalendarCreates(db as never)).resolves.toEqual({
      scanned: 1,
      reconciled: 1,
      failed: 0,
    });
    expect(google.remove).toHaveBeenCalledTimes(2);
    await expect(recoverPendingProspectTourGoogleCalendarCleanup(db as never)).resolves.toEqual({
      scanned: 1,
      completed: 1,
      failed: 0,
    });
    expect(google.remove).toHaveBeenCalledTimes(3);
    expect(google.remove).toHaveBeenLastCalledWith(db, managerUserId, deterministicId);
    expect(reconciliationCount).toBe(2);
  });
});
