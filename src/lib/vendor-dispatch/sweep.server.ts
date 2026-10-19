import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { pacificCalendarDateYmd } from "@/lib/pacific-time";
import { recordDispatchEvent } from "@/lib/vendor-dispatch/audit.server";
import {
  advanceRun,
  loadAttempts,
  notifyApprovers,
  requestApproval,
  vendorNamesForApproval,
  loadVendorContacts,
} from "@/lib/vendor-dispatch/engine.server";
import { isMissingRelationError } from "@/lib/vendor-dispatch/match.server";
import { timeoutAttempt } from "@/lib/vendor-dispatch/responses.server";
import { sendVendorDispatchText } from "@/lib/vendor-dispatch/send.server";
import { composeApprovalText, composeQuoteAskText, toGsm7 } from "@/lib/vendor-dispatch/text";
import { formatPacificShort } from "@/lib/vendor-dispatch/time";
import { APPROVAL_REMINDER_MINUTES } from "@/lib/vendor-dispatch/trades";
import { dispatchCleaningForStays, type TurnoverStay } from "@/lib/vendor-dispatch/triggers.server";
import type { DispatchAttemptRow, DispatchRunRow } from "@/lib/vendor-dispatch/types";

/**
 * The scheduler tick (vendor-dispatch-1018): vendor timeouts, approval reminders and
 * escalation, stale-run expiry, portal declines, and the checkout-to-cleaner trigger.
 * Runs from `/api/cron/vendor-dispatch-sweep` every two minutes (the same cron rail as
 * `dispatch-reminders` and `sms-outbox`; QStash is only used for prospect bursts).
 * Every step is idempotent and isolated: one run failing never blocks the others.
 */

/** A run nobody approved in this long is stale: cancel it so the job can be dispatched afresh. */
export const STALE_APPROVAL_HOURS = 72;

const minutes = (a: Date, iso: string | null) => (iso ? (a.getTime() - Date.parse(iso)) / 60_000 : Number.POSITIVE_INFINITY);

async function guarded<T>(label: string, errors: string[], task: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await task();
  } catch (error) {
    errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    return fallback;
  }
}

async function sweepTimeouts(db: SupabaseClient, now: Date): Promise<number> {
  const { data, error } = await db
    .from("vendor_dispatch_attempts")
    .select("id")
    .eq("status", "offered")
    .lte("timeout_at", now.toISOString());
  if (error) {
    if (isMissingRelationError(error)) return 0;
    throw new Error(error.message);
  }
  let timedOut = 0;
  for (const row of (data ?? []) as Array<{ id: string }>) {
    if (await timeoutAttempt(db, row.id, now).catch(() => false)) timedOut += 1;
  }
  return timedOut;
}

/** A vendor who declined in the PORTAL (not by text) moves the chain on too. */
async function sweepPortalDeclines(db: SupabaseClient, now: Date): Promise<number> {
  const { data: runs, error } = await db
    .from("vendor_dispatch_runs")
    .select("id, owner_user_id, handle, source_id")
    .eq("source_type", "work_order")
    .eq("status", "offering");
  if (error) {
    if (isMissingRelationError(error)) return 0;
    throw new Error(error.message);
  }
  let moved = 0;
  for (const run of (runs ?? []) as Array<{ id: string; owner_user_id: string; handle: number; source_id: string }>) {
    const attempts = (await loadAttempts(db, run.id)).filter((attempt) => attempt.status === "offered" && attempt.quote_status !== "pending");
    if (attempts.length === 0) continue;
    const { data: offers } = await db
      .from("work_order_vendor_offers")
      .select("vendor_directory_id, status")
      .eq("work_order_id", run.source_id)
      .eq("manager_user_id", run.owner_user_id)
      .in("status", ["declined", "withdrawn"]);
    const closed = new Set(((offers ?? []) as Array<{ vendor_directory_id: string }>).map((offer) => offer.vendor_directory_id));
    let changedAny = false;
    for (const attempt of attempts) {
      if (!closed.has(attempt.vendor_directory_id)) continue;
      const { data: changed } = await db
        .from("vendor_dispatch_attempts")
        .update({ status: "declined", responded_at: now.toISOString(), response_text: "declined in portal", timeout_at: null })
        .eq("id", attempt.id)
        .eq("status", "offered")
        .select("id");
      if (changed && (changed as unknown[]).length > 0) {
        changedAny = true;
        await recordDispatchEvent(db, { ownerUserId: run.owner_user_id, runId: run.id, handle: run.handle, event: "vendor_declined", channel: "system", key: attempt.id, detail: { via: "portal" }, now });
      }
    }
    if (changedAny) {
      await advanceRun(db, run.id, now);
      moved += 1;
    }
  }
  return moved;
}

async function approvalText(db: SupabaseClient, run: DispatchRunRow): Promise<string> {
  const attempts = await loadAttempts(db, run.id);
  const contacts = await loadVendorContacts(db, run.owner_user_id, attempts.map((attempt) => attempt.vendor_directory_id));
  return composeApprovalText({
    handle: run.handle,
    what: String(run.details.what || "Job"),
    houseLabel: String(run.details.houseLabel || run.details.area || "the house"),
    room: run.details.room ?? null,
    vendorNames: vendorNamesForApproval(attempts, contacts),
    payCents: run.pay_cents,
    payModel: run.details.payModel as string | undefined,
    mode: run.mode,
  });
}

/** Resend, then escalate to the next teammate, per the urgency's schedule; expire what nobody ever answered. */
async function sweepApprovals(db: SupabaseClient, now: Date): Promise<{ reminded: number; escalated: number; expired: number }> {
  const { data, error } = await db.from("vendor_dispatch_runs").select("*").eq("status", "awaiting_approval");
  if (error) {
    if (isMissingRelationError(error)) return { reminded: 0, escalated: 0, expired: 0 };
    throw new Error(error.message);
  }
  let reminded = 0;
  let escalated = 0;
  let expired = 0;
  for (const run of (data ?? []) as DispatchRunRow[]) {
    const age = minutes(now, run.created_at);
    const schedule = APPROVAL_REMINDER_MINUTES[run.urgency] ?? APPROVAL_REMINDER_MINUTES.routine;
    if (age >= STALE_APPROVAL_HOURS * 60) {
      const { data: changed } = await db
        .from("vendor_dispatch_runs")
        .update({ status: "canceled", updated_at: now.toISOString() })
        .eq("id", run.id)
        .eq("status", "awaiting_approval")
        .select("id");
      if (changed && (changed as unknown[]).length > 0) {
        await db.from("vendor_dispatch_attempts").update({ status: "canceled", response_text: "approval expired" }).eq("run_id", run.id).eq("status", "queued");
        await recordDispatchEvent(db, { ownerUserId: run.owner_user_id, runId: run.id, handle: run.handle, event: "canceled", key: "expired", detail: { reason: "approval_expired" }, now });
        expired += 1;
      }
      continue;
    }
    // Nobody could be texted the first time (no verified phone, no credit): try again for a while.
    if ((run.approval_notified_user_ids ?? []).length === 0) {
      if (age < 180) await requestApproval(db, run, "first").catch(() => []);
      continue;
    }
    if (age >= schedule.escalate && !run.approval_escalated_at) {
      const reached = await notifyApprovers(db, run, { audience: "remaining", text: await approvalText(db, run), key: "escalate" });
      await db.from("vendor_dispatch_runs").update({ approval_escalated_at: now.toISOString(), updated_at: now.toISOString() }).eq("id", run.id);
      await recordDispatchEvent(db, { ownerUserId: run.owner_user_id, runId: run.id, handle: run.handle, event: "approval_escalated", key: "1", detail: { recipients: reached.length }, now });
      escalated += 1;
    } else if (age >= schedule.resend && !run.approval_reminded_at) {
      const reached = await notifyApprovers(db, run, { audience: "notified", text: await approvalText(db, run), key: "remind" });
      await db.from("vendor_dispatch_runs").update({ approval_reminded_at: now.toISOString(), updated_at: now.toISOString() }).eq("id", run.id);
      await recordDispatchEvent(db, { ownerUserId: run.owner_user_id, runId: run.id, handle: run.handle, event: "approval_reminded", key: "1", detail: { recipients: reached.length }, now });
      reminded += 1;
    }
  }
  return { reminded, escalated, expired };
}

/** A vendor's held quote waits on the manager with the same resend schedule. */
async function sweepQuoteHolds(db: SupabaseClient, now: Date): Promise<number> {
  const { data, error } = await db
    .from("vendor_dispatch_attempts")
    .select("*")
    .eq("status", "offered")
    .eq("quote_status", "pending");
  if (error) {
    if (isMissingRelationError(error)) return 0;
    throw new Error(error.message);
  }
  let reminded = 0;
  for (const attempt of (data ?? []) as DispatchAttemptRow[]) {
    const { data: runRow } = await db.from("vendor_dispatch_runs").select("*").eq("id", attempt.run_id).maybeSingle();
    const run = runRow as DispatchRunRow | null;
    if (!run || run.status !== "offering" || run.approval_reminded_at) continue;
    const schedule = APPROVAL_REMINDER_MINUTES[run.urgency] ?? APPROVAL_REMINDER_MINUTES.routine;
    if (minutes(now, attempt.responded_at) < schedule.resend) continue;
    const contacts = await loadVendorContacts(db, run.owner_user_id, [attempt.vendor_directory_id]);
    await notifyApprovers(db, run, {
      audience: "everyone",
      text: composeQuoteAskText({
        handle: run.handle,
        vendorName: contacts.get(attempt.vendor_directory_id)?.name ?? "Vendor",
        quoteCents: attempt.quote_cents ?? 0,
        capCents: run.nte_cents ?? run.pay_cents,
      }),
      key: `quote-remind-${attempt.id}`,
    });
    await db.from("vendor_dispatch_runs").update({ approval_reminded_at: now.toISOString() }).eq("id", run.id);
    reminded += 1;
  }
  return reminded;
}

/** A vendor with an accepted job is texted once, about an hour before the time they agreed to. */
export const JOB_REMINDER_LEAD_MINUTES = 60;
/** Wide enough that a two-minute tick that runs late still catches it, narrow enough not to nag a far-off job. */
const JOB_REMINDER_WINDOW_MINUTES = 75;

async function sweepJobReminders(db: SupabaseClient, now: Date): Promise<number> {
  const horizon = new Date(now.getTime() + JOB_REMINDER_WINDOW_MINUTES * 60_000).toISOString();
  const { data, error } = await db
    .from("vendor_dispatch_runs")
    .select("*")
    .eq("status", "accepted")
    .is("vendor_done_at", null)
    .not("scheduled_for", "is", null)
    .lte("scheduled_for", horizon);
  if (error) {
    if (isMissingRelationError(error)) return 0;
    throw new Error(error.message);
  }
  let reminded = 0;
  for (const run of (data ?? []) as DispatchRunRow[]) {
    const when = run.scheduled_for ? new Date(run.scheduled_for) : null;
    if (!when || !Number.isFinite(when.getTime()) || when.getTime() <= now.getTime() || !run.accepted_vendor_directory_id) continue;
    // A vendor who accepted minutes ago was just given the time and place: no second text for it.
    if (minutes(now, run.accepted_at) < 30) continue;
    const contact = (await loadVendorContacts(db, run.owner_user_id, [run.accepted_vendor_directory_id])).get(run.accepted_vendor_directory_id);
    if (!contact?.phone) continue;
    const where = toGsm7(String(run.details.houseLabel || run.details.area || "the house"));
    // The outbox key is the once-only guard: a later tick (or a second instance) re-sends nothing.
    const sent = await sendVendorDispatchText(db, {
      ownerUserId: run.owner_user_id,
      workspaceId: run.workspace_id,
      vendorDirectoryId: contact.id,
      phone: contact.phone,
      vendorUserId: contact.vendorUserId,
      text: `Reminder: #${run.handle} at ${where}, ${formatPacificShort(when, now)}. Reply DONE when finished`,
      idempotencyKey: `dispatch-job-reminder-${run.id}`,
    }).catch(() => ({ ok: false as const, reason: "send_failed" }));
    if (!sent.ok) continue;
    await recordDispatchEvent(db, { ownerUserId: run.owner_user_id, runId: run.id, handle: run.handle, event: "vendor_reminded", channel: "system", now });
    reminded += 1;
  }
  return reminded;
}

/** Checkouts today and tomorrow at houses with a cleaner rule. Runs about every ten minutes, not every tick. */
async function sweepTurnovers(db: SupabaseClient, now: Date): Promise<{ created: number; checked: number }> {
  const bookings = await import("@/lib/reminders/subjects/bookings.server");
  const [channel, lease, blocks] = await Promise.all([
    bookings.channelStays(db).catch(() => []),
    bookings.leaseStays(db).catch(() => []),
    bookings.roomDateBlockStays(db).catch(() => []),
  ]);
  const stays: TurnoverStay[] = [...channel, ...lease, ...blocks].map((stay) => ({
    managerUserId: stay.managerUserId,
    subjectId: stay.subjectId,
    checkInKey: stay.checkInKey,
    checkOutKey: stay.checkOutKey,
    propertyId: stay.propertyId,
    propertyLabel: stay.propertyLabel,
    roomId: stay.roomId,
    roomLabel: stay.roomLabel,
    checkInTime: stay.checkInTime,
    checkOutTime: stay.checkOutTime,
  }));
  const todayKey = pacificCalendarDateYmd(now);
  const tomorrowKey = pacificCalendarDateYmd(new Date(now.getTime() + 24 * 3_600_000));
  return dispatchCleaningForStays(db, stays, { todayKey, tomorrowKey });
}

export type DispatchSweepSummary = {
  timedOut: number;
  portalDeclines: number;
  reminded: number;
  escalated: number;
  expired: number;
  quoteReminders: number;
  jobReminders: number;
  turnoversCreated: number;
  errors: string[];
};

export async function sweepVendorDispatch(db: SupabaseClient, now: Date = new Date(), options: { turnovers?: boolean } = {}): Promise<DispatchSweepSummary> {
  const errors: string[] = [];
  const timedOut = await guarded("timeouts", errors, () => sweepTimeouts(db, now), 0);
  const portalDeclines = await guarded("portal_declines", errors, () => sweepPortalDeclines(db, now), 0);
  const approvals = await guarded("approvals", errors, () => sweepApprovals(db, now), { reminded: 0, escalated: 0, expired: 0 });
  const quoteReminders = await guarded("quote_holds", errors, () => sweepQuoteHolds(db, now), 0);
  const jobReminders = await guarded("job_reminders", errors, () => sweepJobReminders(db, now), 0);
  const turnovers =
    options.turnovers === false
      ? { created: 0, checked: 0 }
      : await guarded("turnovers", errors, () => sweepTurnovers(db, now), { created: 0, checked: 0 });
  return { timedOut, portalDeclines, ...approvals, quoteReminders, jobReminders, turnoversCreated: turnovers.created, errors };
}
