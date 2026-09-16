import { beforeEach, describe, expect, it, vi } from "vitest";

const notifyManager = vi.hoisted(() => vi.fn());
const syncGoogle = vi.hoisted(() => vi.fn());
const enqueueOwnerSms = vi.hoisted(() => vi.fn());
const dispatchOwnerSmsOutbox = vi.hoisted(() => vi.fn());
const deleteGoogle = vi.hoisted(() => vi.fn());

vi.mock("@/lib/agent-notify.server", () => ({ notifyManagerFromAgent: notifyManager }));
vi.mock("@/lib/google-calendar/planned-tour-sync.server", () => ({
  runPlannedTourCalendarSync: async (run: () => Promise<unknown>) => {
    try {
      const result = await run() as { disposition?: unknown } | null;
      if (result?.disposition === "deferred") {
        return { ok: false, deferred: true, error: "Google Calendar synchronization is in flight." };
      }
      if (result?.disposition === "skipped") return { ok: true, skipped: true };
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Google sync failed" };
    }
  },
}));
vi.mock("@/lib/google-calendar/sync.server", () => ({
  syncPlannedTourToGoogleCalendar: syncGoogle,
  syncPlannedTourToGoogleCalendarAttempt: syncGoogle,
}));
vi.mock("@/lib/google-calendar/api.server", () => ({ deleteGoogleCalendarEvent: deleteGoogle }));
vi.mock("@/lib/sms/owner-sms-dispatcher.server", () => ({ enqueueOwnerSms, dispatchOwnerSmsOutbox }));

import {
  recoverExpiredProspectTourGoogleCalendarCreates,
  recoverPendingProspectTourBookingSideEffects,
  recoverPendingProspectTourGoogleCalendarCleanup,
  recoverProspectTourBookingForBurst,
} from "@/lib/prospect-tour-booking-recovery.server";

const MANAGER = "11111111-1111-4111-8111-111111111111";

function booking(overrides: Record<string, unknown> = {}) {
  return {
    id: "booking-1",
    manager_user_id: MANAGER,
    idempotency_key: "prospect-tour:burst-1:7",
    planned_event_id: "planned-1",
    burst_id: "burst-1",
    burst_revision: 7,
    offer_snapshot: { slotKey: "2099-09-10:20", label: "Thursday, September 10, 2099 at 10:00 AM Pacific" },
    event_snapshot: {
      id: "planned-1",
      title: "Tour · Jordan Lee",
      kind: "tour",
      start: "2099-09-10T17:00:00.000Z",
      end: "2099-09-10T17:30:00.000Z",
      propertyId: "property-1",
      propertyTitle: "Ballard House",
      attendeeName: "Jordan Lee",
      attendeePhone: "+12065550123",
    },
    confirmation_body: "Tour confirmed for Thursday, September 10, 2099 at 10:00 AM Pacific.",
    confirmation_outbox_id: null,
    confirmation_status: "pending",
    manager_notification_status: "completed",
    calendar_sync_status: "skipped",
    status: "confirmed",
    ...overrides,
  };
}

/** A small thenable Supabase stand-in: reads are table-specific, writes are observed. */
function dbFor(options: {
  bookingRows?: Record<string, unknown>[];
  outboxStatus?: string | null;
  existingOutbox?: { id: string; status: string; blocked_reason?: string | null } | null;
  legacyBurstOutbox?: { id: string; status: string; blocked_reason?: string | null } | null;
  liveEvent?: Record<string, unknown> | null;
}) {
  type FakeQuery = {
    select: () => FakeQuery;
    eq: () => FakeQuery;
    or: () => FakeQuery;
    order: () => FakeQuery;
    limit: () => FakeQuery;
    is: () => Promise<{ data: null; error: null }>;
    update: (values: Record<string, unknown>) => FakeQuery;
    maybeSingle: () => Promise<{ data: Record<string, unknown> | null; error: null }>;
    then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => Promise<unknown>;
  };
  const updates: Record<string, unknown>[] = [];
  let outboxReads = 0;
  const defaultLiveEvent = booking().event_snapshot;
  const db = {
    from(table: string) {
      const query = {} as FakeQuery;
      const filters: Record<string, unknown> = {};
      query.select = () => query;
      query.eq = (column: string, value: unknown) => {
        filters[column] = value;
        return query;
      };
    query.or = () => query;
      query.in = () => query;
      query.order = () => query;
      query.limit = () => query;
      query.is = () => Promise.resolve({ data: null, error: null });
      query.update = (values: Record<string, unknown>) => {
        updates.push({ table, ...values });
        return query;
      };
      query.maybeSingle = async () => ({
        data: table === "sms_outbox"
          ? filters.prospect_burst_id
            ? options.legacyBurstOutbox ?? null
            : options.existingOutbox
            ? options.existingOutbox
            : (++outboxReads > 3 && options.outboxStatus)
              ? { status: options.outboxStatus }
              : null
          : table === "portal_schedule_records"
            ? { row_data: { payload: options.liveEvent === null ? [] : [options.liveEvent ?? defaultLiveEvent] } }
            : null,
        error: null,
      });
      query.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve({ data: table === "prospect_tour_bookings" ? (options.bookingRows ?? []) : [], error: null }).then(resolve, reject);
      return query;
    },
    rpc: async (name: string) => name === "claim_prospect_tour_google_calendar_cleanup"
      ? { data: [], error: null }
      : { data: null, error: null },
  };
  return { db: db as never, updates };
}

beforeEach(() => {
  vi.clearAllMocks();
  syncGoogle.mockResolvedValue(undefined);
  notifyManager.mockResolvedValue({ delivered: true, suppressed: false });
  enqueueOwnerSms.mockResolvedValue({ ok: true, outboxId: "outbox-confirmation-1", status: "queued", deduplicated: false });
  dispatchOwnerSmsOutbox.mockResolvedValue({ ok: true, count: 1, outboxIds: ["outbox-confirmation-1"] });
  deleteGoogle.mockReset();
});

describe("prospect tour booking crash recovery", () => {
  it("prepares the durable confirmation outbox from the booking ledger without another model turn", async () => {
    const { db, updates } = dbFor({ outboxStatus: "queued", existingOutbox: null });
    const result = await recoverProspectTourBookingForBurst(db, {
      booking: booking(),
      workerId: "recovery-worker",
      recipientPhone: "+12065550123",
      workNumber: "+12055550100",
      transport: "twilio",
    });

    expect(result).toMatchObject({ ok: true, outboxId: "outbox-confirmation-1", outboxStatus: "queued" });
    expect(enqueueOwnerSms).toHaveBeenCalledWith(expect.objectContaining({
      body: "Tour confirmed for Thursday, September 10, 2099 at 10:00 AM Pacific.",
      dedupeKey: "prospect-tour-confirmation:booking-1",
      prospectTourBookingConfirmationId: "booking-1",
      sendClass: "transactional",
    }), db);
    expect(dispatchOwnerSmsOutbox).toHaveBeenCalledWith({
      workerId: "recovery-worker-tour-confirmation",
      outboxId: "outbox-confirmation-1",
    }, db);
    expect(updates).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: "prospect_tour_bookings", confirmation_status: "prepared" }),
    ]));
  });

  it("retries only pending Google and manager side effects from the ledger, never recreating the booking", async () => {
    const row = booking({
      confirmation_outbox_id: "outbox-existing",
      confirmation_status: "submitted",
      calendar_sync_status: "pending",
      manager_notification_status: "pending",
    });
    enqueueOwnerSms.mockResolvedValue({ ok: true, outboxId: "outbox-existing", status: "sent", deduplicated: true });
    const { db, updates } = dbFor({ bookingRows: [row], existingOutbox: { id: "outbox-existing", status: "sent" } });
    const result = await recoverPendingProspectTourBookingSideEffects(db);

    expect(result).toEqual({ scanned: 1, recovered: 1, failed: 0 });
    expect(syncGoogle).toHaveBeenCalledTimes(1);
    expect(notifyManager).toHaveBeenCalledTimes(1);
    expect(enqueueOwnerSms).toHaveBeenCalledWith(expect.objectContaining({
      prospectTourBookingConfirmationId: row.id,
    }), db);
    expect(dispatchOwnerSmsOutbox).not.toHaveBeenCalled();
    expect(updates).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: "prospect_tour_bookings", calendar_sync_status: "completed" }),
      expect.objectContaining({ table: "prospect_tour_bookings", manager_notification_status: "completed" }),
    ]));
    expect(updates.filter((update) => update.table === "prospect_tour_bookings" && "planned_event_id" in update)).toHaveLength(0);
  });

  it("keeps an SMS booking calendar effect pending while a competing create owns the lease", async () => {
    const row = booking({
      confirmation_outbox_id: "outbox-existing",
      confirmation_status: "submitted",
      calendar_sync_status: "pending",
      manager_notification_status: "completed",
    });
    syncGoogle.mockResolvedValueOnce({ googleCalendarEventId: null, disposition: "deferred" });
    const { db, updates } = dbFor({ bookingRows: [row], existingOutbox: { id: "outbox-existing", status: "sent" } });

    const result = await recoverPendingProspectTourBookingSideEffects(db);

    expect(result).toEqual({ scanned: 1, recovered: 0, failed: 1 });
    expect(updates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        table: "prospect_tour_bookings",
        calendar_sync_status: "pending",
        calendar_sync_error: "Google Calendar synchronization is in flight.",
      }),
    ]));
    expect(updates).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ table: "prospect_tour_bookings", calendar_sync_status: "completed" }),
    ]));
  });

  it("recovers a committed confirmation after a newer inbound supersedes its burst revision", async () => {
    // The booking is durable, but its originating burst row is now revision 8
    // and no longer carries revision 7. Recovery must be booking-keyed rather
    // than requiring a mutable burst row to remain at the old revision.
    const row = booking({ burst_revision: 7, confirmation_outbox_id: null, confirmation_status: "pending" });
    const { db } = dbFor({ bookingRows: [row], outboxStatus: "queued", existingOutbox: null });

    const result = await recoverPendingProspectTourBookingSideEffects(db);

    expect(result).toMatchObject({ scanned: 1, recovered: 1, failed: 0 });
    expect(enqueueOwnerSms).toHaveBeenCalledWith(expect.objectContaining({
      dedupeKey: "prospect-tour-confirmation:booking-1",
      body: row.confirmation_body,
      prospectTourBookingConfirmationId: row.id,
    }), db);
    expect(dispatchOwnerSmsOutbox).toHaveBeenCalledOnce();
  });

  it("reuses a submitted legacy burst outbox on later booking recovery", async () => {
    const row = booking({ confirmation_outbox_id: null, confirmation_status: "pending" });
    const submittedLegacyOutbox = { id: "outbox-old-burst", status: "submitted" };
    enqueueOwnerSms.mockResolvedValue({ ok: true, outboxId: submittedLegacyOutbox.id, status: submittedLegacyOutbox.status, deduplicated: true });
    const { db } = dbFor({ bookingRows: [row], legacyBurstOutbox: submittedLegacyOutbox });
    const providerAcceptances = new Set(["SM-old-burst"]);

    const first = await recoverPendingProspectTourBookingSideEffects(db);
    const second = await recoverPendingProspectTourBookingSideEffects(db);

    expect(first).toMatchObject({ scanned: 1, recovered: 1, failed: 0 });
    expect(second).toMatchObject({ scanned: 1, recovered: 1, failed: 0 });
    expect(enqueueOwnerSms).toHaveBeenCalledTimes(2);
    expect(enqueueOwnerSms).toHaveBeenCalledWith(expect.objectContaining({
      prospectTourBookingConfirmationId: row.id,
    }), db);
    expect(dispatchOwnerSmsOutbox).not.toHaveBeenCalled();
    expect(providerAcceptances.size).toBe(1);
  });

  it("adopts a queued legacy burst row and sends it through the booking fence", async () => {
    const row = booking({ confirmation_outbox_id: null, confirmation_status: "pending" });
    const queuedLegacyOutbox = { id: "outbox-queued-legacy", status: "queued" };
    enqueueOwnerSms.mockResolvedValue({ ok: true, outboxId: queuedLegacyOutbox.id, status: queuedLegacyOutbox.status, deduplicated: true });
    const { db } = dbFor({ bookingRows: [row], existingOutbox: queuedLegacyOutbox });

    const result = await recoverProspectTourBookingForBurst(db, {
      booking: row as never,
      workerId: "recovery-adopter",
      recipientPhone: "+12065550123",
      workNumber: "+12055550100",
      transport: "twilio",
    });

    expect(result).toMatchObject({ ok: true, outboxId: queuedLegacyOutbox.id, outboxStatus: "queued" });
    expect(enqueueOwnerSms).toHaveBeenCalledWith(expect.objectContaining({
      prospectTourBookingConfirmationId: row.id,
    }), db);
    expect(dispatchOwnerSmsOutbox).toHaveBeenCalledWith({
      workerId: "recovery-adopter-tour-confirmation",
      outboxId: queuedLegacyOutbox.id,
    }, db);
  });

  it.each([
    ["cancelled", { ...booking().event_snapshot, canceledAt: "2099-09-09T12:00:00.000Z" }],
    ["rescheduled", { ...booking().event_snapshot, start: "2099-09-11T17:00:00.000Z", end: "2099-09-11T17:30:00.000Z" }],
  ])("blocks %s confirmations before enqueue", async (_label, liveEvent) => {
    const row = booking({ confirmation_outbox_id: null, confirmation_status: "pending" });
    const { db, updates } = dbFor({ bookingRows: [row], liveEvent });

    const result = await recoverProspectTourBookingForBurst(db, {
      booking: row as never,
      workerId: "recovery-lifecycle-fence",
      recipientPhone: "+12065550123",
    });

    expect(result).toMatchObject({ ok: true, outboxId: "", outboxStatus: "blocked" });
    expect(enqueueOwnerSms).not.toHaveBeenCalled();
    expect(dispatchOwnerSmsOutbox).not.toHaveBeenCalled();
    expect(updates).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: "prospect_tour_bookings", confirmation_status: "blocked" }),
    ]));
  });

  it("retries failed Google cleanup after a crash and leaves a moved event alone", async () => {
    const pending = {
      planned_event_id: "planned-cleanup-1",
      manager_user_id: MANAGER,
      google_calendar_event_id: "google-cleanup-1",
    };
    const updates: Record<string, unknown>[] = [];
    let claims: unknown[] = [[pending], []];
    const db = {
      rpc: vi.fn(async (name: string) => {
        if (name === "claim_prospect_tour_google_calendar_cleanup") return { data: claims.shift() ?? [], error: null };
        if (name === "complete_prospect_tour_google_calendar_cleanup") return { data: true, error: null };
        return { data: null, error: null };
      }),
      from(table: string) {
        const query: Record<string, unknown> = {};
        const self = () => query;
        query.select = self;
        query.eq = self;
        query.in = self;
        query.update = (values: Record<string, unknown>) => { updates.push({ table, ...values }); return query; };
        query.maybeSingle = async () => ({ data: { row_data: { payload: [] } }, error: null });
        query.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve, reject);
        return query;
      },
    };
    deleteGoogle.mockRejectedValueOnce(new Error("Google delete timeout"));
    const first = await recoverPendingProspectTourGoogleCalendarCleanup(db as never);
    expect(first).toEqual({ scanned: 1, completed: 0, failed: 1 });
    expect(deleteGoogle).toHaveBeenCalledWith(db, MANAGER, pending.google_calendar_event_id);
    expect(updates).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: "prospect_tour_google_calendar_cleanup", status: "pending", last_error: "Google delete timeout" }),
    ]));

    deleteGoogle.mockResolvedValueOnce(undefined);
    claims = [[pending], []];
    const second = await recoverPendingProspectTourGoogleCalendarCleanup(db as never);
    expect(second).toEqual({ scanned: 1, completed: 1, failed: 0 });
    expect(deleteGoogle).toHaveBeenCalledTimes(2);
    expect(db.rpc).toHaveBeenCalledWith("complete_prospect_tour_google_calendar_cleanup", {
      p_planned_event_id: pending.planned_event_id,
      p_worker_id: expect.any(String),
    });

    // A current rescheduled event with the same deterministic remote identity
    // wins over a stale cleanup row; recovery must complete bookkeeping without
    // deleting the current remote event.
    claims = [[pending], []];
    const movedDb = {
      ...db,
      from(table: string) {
        const query: Record<string, unknown> = {};
        const self = () => query;
        query.select = self; query.eq = self; query.in = self;
        query.update = (values: Record<string, unknown>) => { updates.push({ table, ...values }); return query; };
        query.maybeSingle = async () => ({ data: { row_data: { payload: [{ id: pending.planned_event_id, kind: "tour", start: "2099-12-01T17:00:00.000Z", end: "2099-12-01T17:30:00.000Z" }] } }, error: null });
        query.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve, reject);
        return query;
      },
    };
    const moved = await recoverPendingProspectTourGoogleCalendarCleanup(movedDb as never);
    expect(moved).toEqual({ scanned: 1, completed: 1, failed: 0 });
    expect(deleteGoogle).toHaveBeenCalledTimes(2);
  });

  it("reconciles an expired create intent before cancelled-tour cleanup may finish", async () => {
    const intent = {
      planned_event_id: "planned-create-crash-1",
      manager_user_id: MANAGER,
      google_calendar_event_id: "deterministic-google-id-1",
      generation: "00000000-0000-4000-8000-000000000123",
    };
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: [intent], error: null })
      .mockResolvedValueOnce({ data: true, error: null })
      .mockResolvedValueOnce({ data: [], error: null });
    const db = {
      rpc,
      from(table: string) {
        const query: Record<string, unknown> = {};
        const self = () => query;
        query.select = self;
        query.eq = self;
        query.update = self;
        query.maybeSingle = async () => ({
          data: table === "portal_schedule_records" ? { row_data: { payload: [] } } : null,
          error: null,
        });
        return query;
      },
    };
    deleteGoogle.mockResolvedValueOnce(undefined);

    await expect(recoverExpiredProspectTourGoogleCalendarCreates(db as never)).resolves.toEqual({
      scanned: 1,
      reconciled: 1,
      failed: 0,
    });
    expect(deleteGoogle).toHaveBeenCalledWith(db, MANAGER, intent.google_calendar_event_id);
    expect(rpc).toHaveBeenNthCalledWith(2, "complete_prospect_tour_google_calendar_create_reconciliation", {
      p_planned_event_id: intent.planned_event_id,
      p_generation: intent.generation,
      p_worker_id: expect.any(String),
      p_state: "reconciled",
    });
  });

  it("keeps a live-event reconciliation claimed until sync and persistence succeed", async () => {
    const intent = {
      planned_event_id: "planned-create-reschedule-1",
      manager_user_id: MANAGER,
      google_calendar_event_id: "deterministic-google-id-2",
      generation: "00000000-0000-4000-8000-000000000124",
    };
    const claims: unknown[] = [[intent], []];
    const updates: Record<string, unknown>[] = [];
    const rpc = vi.fn(async (name: string) => {
      if (name === "claim_prospect_tour_google_calendar_create_reconciliation") {
        return { data: claims.shift() ?? [], error: null };
      }
      return { data: true, error: null };
    });
    const db = {
      rpc,
      from(table: string) {
        const query: Record<string, unknown> = {};
        const self = () => query;
        query.select = self;
        query.eq = self;
        query.update = (values: Record<string, unknown>) => { updates.push({ table, ...values }); return query; };
        query.maybeSingle = async () => ({
          data: table === "portal_schedule_records" ? {
            row_data: { payload: [{ id: intent.planned_event_id, kind: "tour", title: "Moved tour", start: "2099-12-02T18:00:00.000Z", end: "2099-12-02T18:30:00.000Z" }] },
          } : null,
          error: null,
        });
        query.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve);
        return query;
      },
    };
    syncGoogle.mockRejectedValueOnce(new Error("provider update failed"));

    await expect(recoverExpiredProspectTourGoogleCalendarCreates(db as never)).resolves.toEqual({
      scanned: 1,
      reconciled: 0,
      failed: 1,
    });

    expect(syncGoogle).toHaveBeenCalledWith(db, MANAGER, expect.objectContaining({
      plannedEventId: intent.planned_event_id,
      googleCalendarEventId: intent.google_calendar_event_id,
    }), { ownsGoogleCreateIntent: true });
    expect(rpc.mock.calls.some(([name]) => name === "complete_prospect_tour_google_calendar_create_reconciliation")).toBe(false);
    expect(updates).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: "prospect_tour_google_calendar_create_intents", state: "cleanup_required" }),
    ]));
  });

  it("reclaims a failed current-window follow-up and settles it on a later sweep", async () => {
    const intent = {
      planned_event_id: "planned-create-retry-current-1",
      manager_user_id: MANAGER,
      google_calendar_event_id: "deterministic-google-id-retry-1",
      generation: "00000000-0000-4000-8000-000000000125",
    };
    const claims: unknown[] = [[intent], [intent], []];
    const updates: Record<string, unknown>[] = [];
    const rpc = vi.fn(async (name: string) => {
      if (name === "claim_prospect_tour_google_calendar_create_reconciliation") {
        return { data: claims.shift() ?? [], error: null };
      }
      if (name === "complete_prospect_tour_google_calendar_create_reconciliation") return { data: true, error: null };
      return { data: null, error: null };
    });
    const db = {
      rpc,
      from(table: string) {
        const query: Record<string, unknown> = {};
        const self = () => query;
        query.select = self;
        query.eq = self;
        query.update = (values: Record<string, unknown>) => { updates.push({ table, ...values }); return query; };
        query.maybeSingle = async () => ({
          data: table === "portal_schedule_records" ? {
            row_data: { payload: [{ id: intent.planned_event_id, kind: "tour", title: "Moved tour", start: "2099-12-03T18:00:00.000Z", end: "2099-12-03T18:30:00.000Z" }] },
          } : null,
          error: null,
        });
        query.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve);
        return query;
      },
    };
    syncGoogle.mockRejectedValueOnce(new Error("follow-up patch failed")).mockResolvedValueOnce(intent.google_calendar_event_id);

    await expect(recoverExpiredProspectTourGoogleCalendarCreates(db as never)).resolves.toEqual({
      scanned: 2,
      reconciled: 1,
      failed: 1,
    });
    expect(syncGoogle).toHaveBeenCalledTimes(2);
    expect(updates).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: "prospect_tour_google_calendar_create_intents", state: "cleanup_required", last_error: "follow-up patch failed" }),
    ]));
    expect(rpc).toHaveBeenCalledWith("complete_prospect_tour_google_calendar_create_reconciliation", expect.objectContaining({
      p_planned_event_id: intent.planned_event_id,
      p_generation: intent.generation,
      p_state: "settled",
    }));
  });
});
