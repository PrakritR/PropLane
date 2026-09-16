import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { notifyManagerFromAgent } from "@/lib/agent-notify.server";
import { runPlannedTourCalendarSync } from "@/lib/google-calendar/planned-tour-sync.server";
import { syncPlannedTourToGoogleCalendar } from "@/lib/google-calendar/sync.server";
import { deleteGoogleCalendarEvent } from "@/lib/google-calendar/api.server";
import { buildConversationKey } from "@/lib/sms-conversation-identity";
import { dispatchOwnerSmsOutbox, enqueueOwnerSms } from "@/lib/sms/owner-sms-dispatcher.server";

type BookingRow = {
  id: string;
  manager_user_id: string;
  idempotency_key: string;
  planned_event_id: string;
  burst_id: string;
  burst_revision: number;
  offer_snapshot: Record<string, unknown>;
  event_snapshot: Record<string, unknown>;
  confirmation_body: string;
  confirmation_outbox_id: string | null;
  confirmation_status: "pending" | "prepared" | "submitted" | "blocked";
  manager_notification_status: "pending" | "completed" | "suppressed";
  calendar_sync_status: "pending" | "completed" | "skipped";
  status: "confirmed" | "cancelled" | "rescheduled";
};

const BOOKING_COLUMNS = [
  "id", "manager_user_id", "idempotency_key", "planned_event_id", "burst_id", "burst_revision",
  "offer_snapshot", "event_snapshot", "confirmation_body", "confirmation_outbox_id",
  "confirmation_status", "manager_notification_status", "calendar_sync_status", "status",
].join(",");

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function loadCurrentPlannedEvent(db: SupabaseClient, plannedEventId: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await db.from("portal_schedule_records")
    .select("row_data")
    .eq("id", "axis_admin_planned_events_v1")
    .maybeSingle();
  if (error) throw new Error("prospect_tour_calendar_state_unavailable");
  const rowData = data?.row_data && typeof data.row_data === "object" ? data.row_data as { payload?: unknown } : null;
  const rows = Array.isArray(rowData?.payload) ? rowData.payload : [];
  return rows.find((row): row is Record<string, unknown> =>
    Boolean(row && typeof row === "object" && !Array.isArray(row) && text((row as Record<string, unknown>).id) === plannedEventId),
  ) ?? null;
}

export async function loadConfirmedProspectTourBooking(
  db: SupabaseClient,
  args: { managerUserId: string; burstId: string; burstRevision?: number },
): Promise<BookingRow | null> {
  let query = db.from("prospect_tour_bookings")
    .select(BOOKING_COLUMNS)
    .eq("manager_user_id", args.managerUserId)
    .eq("burst_id", args.burstId)
    .eq("status", "confirmed");
  if (args.burstRevision !== undefined) query = query.eq("burst_revision", args.burstRevision);
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error("prospect_tour_booking_recovery_unavailable");
  return data as unknown as BookingRow | null;
}

export async function recoverProspectTourBookingSideEffects(
  db: SupabaseClient,
  booking: BookingRow,
): Promise<{ calendarSync: { ok: boolean; skipped?: boolean; error?: string }; managerNotification: { ok: boolean; suppressed?: boolean; error?: string } }> {
  // A booking snapshot is an audit record, never permission to recreate a
  // deleted or cancelled event. All recovery reads the current calendar row.
  const liveEvent = await loadCurrentPlannedEvent(db, booking.planned_event_id);
  if (!liveEvent || liveEvent.canceledAt) {
    return {
      calendarSync: { ok: true, skipped: true },
      managerNotification: { ok: true, suppressed: true },
    };
  }
  const event = liveEvent;
  const offer = booking.offer_snapshot ?? {};
  let calendarSync: { ok: boolean; skipped?: boolean; error?: string } = {
    ok: booking.calendar_sync_status !== "pending",
    skipped: booking.calendar_sync_status === "skipped" || undefined,
  };
  if (booking.calendar_sync_status === "pending") {
    // A prior attempt may have created the remote event and persisted its ID
    // into the live calendar before crashing. Reload the live event so a retry
    // updates that remote event instead of creating a duplicate from the older
    // booking snapshot.
    calendarSync = await runPlannedTourCalendarSync(() =>
      syncPlannedTourToGoogleCalendar(db, booking.manager_user_id, {
        plannedEventId: booking.planned_event_id,
        title: text(event.title) || "Prospect tour",
        start: text(event.start),
        end: text(event.end),
        propertyTitle: text(event.propertyTitle) || undefined,
        attendeeName: text(event.attendeeName) || undefined,
        attendeeEmail: text(event.attendeeEmail) || undefined,
        attendeePhone: text(event.attendeePhone) || undefined,
        googleCalendarEventId: text(event.googleCalendarEventId) || undefined,
      }),
    );
    await db.from("prospect_tour_bookings").update({
      calendar_sync_status: calendarSync.ok ? (calendarSync.skipped ? "skipped" : "completed") : "pending",
      calendar_sync_error: calendarSync.ok ? null : calendarSync.error ?? "Google Calendar update failed.",
      updated_at: new Date().toISOString(),
    }).eq("id", booking.id).eq("calendar_sync_status", "pending");
  }

  let managerNotification: { ok: boolean; suppressed?: boolean; error?: string } = {
    ok: booking.manager_notification_status !== "pending",
    suppressed: booking.manager_notification_status === "suppressed" || undefined,
  };
  if (booking.manager_notification_status === "pending") {
    try {
      const notified = await notifyManagerFromAgent(db, {
        landlordId: booking.manager_user_id,
        subject: "Prospect tour confirmed",
        text: [
          `${text(event.attendeeName) || "A prospect"} confirmed a tour for ${text(event.propertyTitle) || "a property"}.`,
          text(offer.label) || text(event.start),
          text(event.attendeePhone) ? `Phone: ${text(event.attendeePhone)}` : null,
          text(event.attendeeEmail) ? `Email: ${text(event.attendeeEmail)}` : null,
        ].filter(Boolean).join("\n"),
        externalText: `A prospect tour was confirmed for ${text(offer.label) || "the selected time"}.`,
        threadType: "prospect_tour_confirmed",
        url: "/portal/calendar",
        category: "leasing",
        notify: { push: true, sms: true },
        idempotencyKey: `prospect-tour-confirmed:${booking.planned_event_id}`,
      });
      managerNotification = { ok: notified.delivered || notified.suppressed, suppressed: notified.suppressed };
      await db.from("prospect_tour_bookings").update({
        manager_notification_status: notified.suppressed ? "suppressed" : "completed",
        manager_notification_error: null,
        updated_at: new Date().toISOString(),
      }).eq("id", booking.id).eq("manager_notification_status", "pending");
    } catch (error) {
      managerNotification = { ok: false, error: error instanceof Error ? error.message : "Manager notification failed." };
      await db.from("prospect_tour_bookings").update({
        manager_notification_error: managerNotification.error,
        updated_at: new Date().toISOString(),
      }).eq("id", booking.id).eq("manager_notification_status", "pending");
    }
  }
  return { calendarSync, managerNotification };
}

function confirmationStatus(outboxStatus: string): BookingRow["confirmation_status"] {
  if (["submitted", "sent", "delivered"].includes(outboxStatus)) return "submitted";
  if (["blocked", "unknown"].includes(outboxStatus)) return "blocked";
  return "prepared";
}

function isCurrentConfirmationEvent(booking: BookingRow, event: Record<string, unknown> | null): boolean {
  if (!event || event.canceledAt) return false;
  const snapshot = booking.event_snapshot ?? {};
  return text(event.start) === text(snapshot.start)
    && text(event.end) === text(snapshot.end)
    && text(event.slotKey) === text(snapshot.slotKey);
}

/** Recover a committed confirmation without depending on the mutable burst.
 * The booking-specific outbox row has its own final provider fence, which
 * rechecks the live event immediately before submission. */
export async function recoverProspectTourBookingConfirmation(
  db: SupabaseClient,
  args: { booking: BookingRow; workerId: string },
): Promise<{ ok: true; outboxId: string | null; outboxStatus: string; terminal: boolean } | { ok: false; error: string }> {
  const liveEvent = await loadCurrentPlannedEvent(db, args.booking.planned_event_id);
  if (!isCurrentConfirmationEvent(args.booking, liveEvent)) {
    await db.from("prospect_tour_bookings").update({
      confirmation_status: "blocked",
      updated_at: new Date().toISOString(),
    }).eq("id", args.booking.id).eq("status", "confirmed")
      .in("confirmation_status", ["pending", "prepared"]);
    return { ok: true, outboxId: null, outboxStatus: "blocked", terminal: true };
  }
  const recipientPhone = text(args.booking.event_snapshot?.attendeePhone);
  const enqueued = await enqueueOwnerSms({
    managerUserId: args.booking.manager_user_id,
    actorUserId: args.booking.manager_user_id,
    recipientPhone,
    body: args.booking.confirmation_body,
    sendClass: "transactional",
    purpose: "manager_conversation",
    conversationKey: buildConversationKey({
      ownerManagerUserId: args.booking.manager_user_id,
      role: "prospect",
      counterpartyPhone: recipientPhone,
    }),
    counterpartyRole: "prospect",
    propertyId: text(liveEvent?.propertyId) || null,
    dedupeKey: `prospect-tour-confirmation:${args.booking.id}`,
    prospectTourBookingConfirmationId: args.booking.id,
  }, db);
  if (!enqueued.ok) return { ok: false, error: enqueued.error };
  // The booking-keyed enqueue RPC owns the link and atomically adopts or
  // supersedes any legacy burst row. Do not recreate that arbitration here.
  if (["submitted", "sent", "delivered", "blocked", "unknown"].includes(enqueued.status)) {
    return { ok: true, outboxId: enqueued.outboxId, outboxStatus: enqueued.status, terminal: true };
  }
  await dispatchOwnerSmsOutbox({ workerId: `${args.workerId}-tour-confirmation`, outboxId: enqueued.outboxId }, db);
  const { data: outbox } = await db.from("sms_outbox").select("status").eq("id", enqueued.outboxId).maybeSingle();
  const outboxStatus = String(outbox?.status ?? enqueued.status);
  await db.from("prospect_tour_bookings").update({
    confirmation_status: confirmationStatus(outboxStatus),
    updated_at: new Date().toISOString(),
  }).eq("id", args.booking.id).eq("confirmation_outbox_id", enqueued.outboxId);
  return {
    ok: true,
    outboxId: enqueued.outboxId,
    outboxStatus,
    terminal: ["submitted", "sent", "delivered", "blocked", "unknown"].includes(outboxStatus),
  };
}

export async function recoverProspectTourBookingForBurst(
  db: SupabaseClient,
  args: {
    booking: BookingRow;
    workerId: string;
    recipientPhone: string;
    workNumber?: string | null;
    transport?: "twilio" | "claw";
  },
): Promise<{ ok: true; outboxId: string; outboxStatus: string; sideEffects: Awaited<ReturnType<typeof recoverProspectTourBookingSideEffects>> } | { ok: false; error: string }> {
  const sideEffects = await recoverProspectTourBookingSideEffects(db, args.booking);
  const confirmation = await recoverProspectTourBookingConfirmation(db, { booking: args.booking, workerId: args.workerId });
  if (!confirmation.ok) return confirmation;
  return { ok: true, outboxId: confirmation.outboxId ?? "", outboxStatus: confirmation.outboxStatus, sideEffects };
}

/** Drain cancellation/deletion cleanup independently of the booking lifecycle.
 * A cancelled booking can no longer be selected by the confirmation recovery,
 * but its remote Google event still has to be removed after a crash. */
export async function recoverPendingProspectTourGoogleCalendarCleanup(
  db: SupabaseClient,
  limit = 10,
): Promise<{ scanned: number; completed: number; failed: number }> {
  const workerId = `prospect-tour-google-cleanup-${crypto.randomUUID()}`;
  let scanned = 0;
  let completed = 0;
  let failed = 0;
  for (let index = 0; index < limit; index += 1) {
    const { data, error } = await db.rpc("claim_prospect_tour_google_calendar_cleanup", {
      p_worker_id: workerId,
      p_lease_seconds: 120,
    });
    if (error) throw new Error("prospect_tour_google_cleanup_unavailable");
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.planned_event_id || !row?.google_calendar_event_id || !row?.manager_user_id) break;
    scanned += 1;
    const plannedEventId = String(row.planned_event_id);
    const managerUserId = String(row.manager_user_id);
    const googleCalendarEventId = String(row.google_calendar_event_id);
    try {
      // A recreated/current event with this deterministic id wins. Never let a
      // stale cancellation cleanup delete a current rescheduled event.
      const live = await loadCurrentPlannedEvent(db, plannedEventId);
      if (!live || live.canceledAt) {
        await deleteGoogleCalendarEvent(db, managerUserId, googleCalendarEventId);
      }
      const { data: completedCleanup, error: completeError } = await db.rpc("complete_prospect_tour_google_calendar_cleanup", {
        p_planned_event_id: plannedEventId,
        p_worker_id: workerId,
      });
      if (completeError) throw completeError;
      if (completedCleanup === true) completed += 1;
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : "Google Calendar cleanup failed.";
      await db.from("prospect_tour_google_calendar_cleanup")
        .update({ status: "pending", last_error: message, lease_owner: null, lease_expires_at: null, updated_at: new Date().toISOString() })
        .eq("planned_event_id", plannedEventId)
        .eq("lease_owner", workerId)
        .eq("status", "running");
    }
  }
  return { scanned, completed, failed };
}

/**
 * A create that died after the request started cannot be inferred from a 404
 * cleanup response. Its provider lease must expire first, then this recovery
 * path owns the deterministic id before cleanup is allowed to finish.
 */
export async function recoverExpiredProspectTourGoogleCalendarCreates(
  db: SupabaseClient,
  limit = 10,
): Promise<{ scanned: number; reconciled: number; failed: number }> {
  const workerId = `prospect-tour-google-create-recovery-${crypto.randomUUID()}`;
  let scanned = 0;
  let reconciled = 0;
  let failed = 0;
  for (let index = 0; index < limit; index += 1) {
    const { data, error } = await db.rpc("claim_prospect_tour_google_calendar_create_reconciliation", {
      p_worker_id: workerId,
      p_lease_seconds: 120,
    });
    if (error) throw new Error("prospect_tour_google_create_recovery_unavailable");
    const row = Array.isArray(data) ? data[0] : data;
    if (!row?.planned_event_id || !row?.manager_user_id || !row?.google_calendar_event_id || !row?.generation) break;
    scanned += 1;
    const plannedEventId = String(row.planned_event_id);
    const managerUserId = String(row.manager_user_id);
    const googleCalendarEventId = String(row.google_calendar_event_id);
    const generation = String(row.generation);
    try {
      const live = await loadCurrentPlannedEvent(db, plannedEventId);
      if (live && !live.canceledAt) {
        // The deterministic id makes a second create/update idempotent. This
        // is a live event, so it wins over an abandoned prior generation. Keep
        // the reconciliation lease until the remote write and lifecycle-safe
        // local persistence both succeed; a crash remains reclaimable.
        const syncedId = await syncPlannedTourToGoogleCalendar(db, managerUserId, {
          plannedEventId,
          title: text(live.title) || "Prospect tour",
          start: text(live.start),
          end: text(live.end),
          propertyTitle: text(live.propertyTitle) || undefined,
          attendeeName: text(live.attendeeName) || undefined,
          attendeeEmail: text(live.attendeeEmail) || undefined,
          attendeePhone: text(live.attendeePhone) || undefined,
          googleCalendarEventId: text(live.googleCalendarEventId) || googleCalendarEventId,
        }, { ownsGoogleCreateIntent: true });
        if (!syncedId) throw new Error("prospect_tour_google_create_reconciliation_not_synced");
        const { data: completedIntent, error: completeIntentError } = await db.rpc(
          "complete_prospect_tour_google_calendar_create_reconciliation",
          {
            p_planned_event_id: plannedEventId,
            p_generation: generation,
            p_worker_id: workerId,
            p_state: "settled",
          },
        );
        if (completeIntentError || completedIntent !== true) throw new Error("prospect_tour_google_create_reconciliation_lost");
      } else {
        await deleteGoogleCalendarEvent(db, managerUserId, googleCalendarEventId);
        const { data: completedIntent, error: completeIntentError } = await db.rpc(
          "complete_prospect_tour_google_calendar_create_reconciliation",
          {
            p_planned_event_id: plannedEventId,
            p_generation: generation,
            p_worker_id: workerId,
            p_state: "reconciled",
          },
        );
        if (completeIntentError || completedIntent !== true) throw new Error("prospect_tour_google_create_reconciliation_lost");
      }
      reconciled += 1;
    } catch (error) {
      failed += 1;
      await db.from("prospect_tour_google_calendar_create_intents")
        .update({ state: "cleanup_required", lease_owner: null, lease_expires_at: null, last_error: error instanceof Error ? error.message : "Google create reconciliation failed.", updated_at: new Date().toISOString() })
        .eq("planned_event_id", plannedEventId)
        .eq("generation", generation)
        .eq("lease_owner", workerId)
        .eq("state", "reconciling");
    }
  }
  return { scanned, reconciled, failed };
}

export async function recoverPendingProspectTourBookingSideEffects(
  db: SupabaseClient,
): Promise<{ scanned: number; recovered: number; failed: number }> {
  const { data, error } = await db.from("prospect_tour_bookings")
    .select(BOOKING_COLUMNS)
    .eq("status", "confirmed")
    .or("manager_notification_status.eq.pending,calendar_sync_status.eq.pending,confirmation_status.in.(pending,prepared)")
    .order("updated_at", { ascending: true })
    .limit(10);
  if (error) throw new Error("prospect_tour_side_effect_recovery_unavailable");
  let recovered = 0;
  let failed = 0;
  for (const row of (data ?? []) as unknown as BookingRow[]) {
    const confirmation = await recoverProspectTourBookingConfirmation(db, {
      booking: row,
      workerId: `prospect-tour-recovery-${row.id}`,
    });
    if (!confirmation.ok) {
      failed += 1;
      continue;
    }
    const result = await recoverProspectTourBookingSideEffects(db, row);
    if (result.calendarSync.ok && result.managerNotification.ok) recovered += 1;
    else failed += 1;
  }
  const creates = await recoverExpiredProspectTourGoogleCalendarCreates(db);
  const cleanup = await recoverPendingProspectTourGoogleCalendarCleanup(db);
  return {
    scanned: (data?.length ?? 0) + creates.scanned + cleanup.scanned,
    recovered: recovered + creates.reconciled + cleanup.completed,
    failed: failed + creates.failed + cleanup.failed,
  };
}
