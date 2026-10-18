import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { syncWorkOrderToGoogleCalendar } from "@/lib/google-calendar/sync.server";
import { formatPacificDateTime } from "@/lib/pacific-time";
import { stampSmsTestProvenance } from "@/lib/sms/sms-test-provenance.server";
import { workOrderEvent } from "@/lib/work-order-events.server";
import { recordDispatchEvent } from "@/lib/vendor-dispatch/audit.server";
import {
  advanceRun,
  canActorApprove,
  loadAttempts,
  loadRun,
  loadVendorContacts,
  notifyApprovers,
  notifyOutcome,
  type VendorContact,
} from "@/lib/vendor-dispatch/engine.server";
import { sendResidentDispatchText, sendVendorDispatchText } from "@/lib/vendor-dispatch/send.server";
import {
  composeManagerAcceptedText,
  composeQuoteAskText,
  composeResidentAcceptedText,
  composeVendorBusyAck,
  composeVendorConfirmText,
  composeVendorDeclinedAck,
  composeVendorQuoteDeclinedText,
  composeVendorQuoteHeldText,
  composeVendorTakenText,
  toGsm7,
} from "@/lib/vendor-dispatch/text";
import { formatPacificShort, parseVendorProposedTime } from "@/lib/vendor-dispatch/time";
import { tradeDefinition } from "@/lib/vendor-dispatch/trades";
import type { DispatchAttemptRow, DispatchRunRow } from "@/lib/vendor-dispatch/types";

/**
 * What happens when a vendor answers an offer (vendor-dispatch-1018): accept, quote
 * above the cap, decline, busy, timeout. Each outcome is one conditional UPDATE on the
 * run first, so a broadcast where two vendors say YES at the same instant has exactly
 * one winner; the loser is told "taken". The run, never the text, names the owner:
 * every function re-derives it from the run and refuses a caller from another workspace.
 */

export type VendorAnswerOutcome =
  | { outcome: "accepted"; scheduledIso: string | null }
  | { outcome: "quote_held" }
  | { outcome: "declined" }
  | { outcome: "busy" }
  | { outcome: "taken" }
  | { outcome: "closed" }
  | { outcome: "ignored" }
  | { outcome: "not_found" };

async function textVendor(
  db: SupabaseClient,
  run: DispatchRunRow,
  contact: VendorContact | undefined,
  attemptId: string,
  text: string,
  key: string,
): Promise<void> {
  if (!contact?.phone) return;
  await sendVendorDispatchText(db, {
    ownerUserId: run.owner_user_id,
    workspaceId: run.workspace_id,
    vendorDirectoryId: contact.id,
    phone: contact.phone,
    vendorUserId: contact.vendorUserId,
    text,
    idempotencyKey: `dispatch-${key}-${attemptId}`,
  }).catch(() => undefined);
}

async function loadAttempt(db: SupabaseClient, attemptId: string): Promise<DispatchAttemptRow | null> {
  const { data } = await db.from("vendor_dispatch_attempts").select("*").eq("id", attemptId).maybeSingle();
  return (data as DispatchAttemptRow | null) ?? null;
}

/** Withdraw every other vendor's portal offer once the job is taken. */
async function withdrawOtherOffers(db: SupabaseClient, run: DispatchRunRow, keepVendorId: string, nowIso: string): Promise<void> {
  if (run.source_type !== "work_order") return;
  await db
    .from("work_order_vendor_offers")
    .update({ status: "withdrawn", updated_at: nowIso })
    .eq("work_order_id", run.source_id)
    .eq("manager_user_id", run.owner_user_id)
    .eq("status", "sent")
    .neq("vendor_directory_id", keepVendorId)
    .then(undefined, () => undefined);
}

export type AssignResult = "assigned" | "conflict" | "skipped" | "error";

/**
 * Put the accepted vendor on the service the way `executeDispatch` does, so Assigned
 * (or Scheduled when a time came with the YES) shows everywhere at once: the manager
 * list and record, the resident portal and the vendor portal. The record is re-read by
 * id AND owner; a service that already has a different vendor is a conflict, never
 * overwritten.
 */
export async function assignWorkOrderForRun(
  db: SupabaseClient,
  run: DispatchRunRow,
  contact: VendorContact,
  scheduledIso: string | null,
  now: Date,
): Promise<AssignResult> {
  if (run.source_type !== "work_order") return "skipped";
  const { data: record } = await db
    .from("portal_work_order_records")
    .select("id, manager_user_id, row_data")
    .eq("id", run.source_id)
    .eq("manager_user_id", run.owner_user_id)
    .maybeSingle();
  const row = ((record as { row_data?: DemoManagerWorkOrderRow } | null)?.row_data ?? null) as DemoManagerWorkOrderRow | null;
  if (!record || !row) return "error";
  if ((row.vendorId && row.vendorId !== contact.id) || row.selfAssigned) return "conflict";

  const nowIso = now.toISOString();
  const nextRow: DemoManagerWorkOrderRow = {
    ...row,
    vendorId: contact.id,
    vendorName: contact.name,
    vendorUserId: contact.vendorUserId,
    vendorAssignedAt: nowIso,
    selfAssigned: false,
    ...(scheduledIso
      ? {
          bucket: "scheduled" as const,
          status: "Scheduled",
          scheduledAtIso: scheduledIso,
          scheduled: formatPacificDateTime(scheduledIso),
        }
      : {}),
  };
  const { error } = await db
    .from("portal_work_order_records")
    .update({
      vendor_user_id: contact.vendorUserId,
      row_data: stampSmsTestProvenance(nextRow as unknown as Record<string, unknown>),
      updated_at: nowIso,
    })
    .eq("id", run.source_id)
    .eq("manager_user_id", run.owner_user_id);
  if (error) return "error";

  if (scheduledIso) {
    const synced = await syncWorkOrderToGoogleCalendar(db, run.owner_user_id, nextRow).catch(() => nextRow);
    if (synced.googleCalendarEventId !== nextRow.googleCalendarEventId) {
      await db
        .from("portal_work_order_records")
        .update({ row_data: stampSmsTestProvenance(synced as unknown as Record<string, unknown>), updated_at: nowIso })
        .eq("id", run.source_id)
        .eq("manager_user_id", run.owner_user_id);
    }
  }
  return "assigned";
}

async function ownerSender(db: SupabaseClient, ownerUserId: string): Promise<{ userId: string; email: string; fullName: string }> {
  const { data } = await db.from("profiles").select("email, full_name").eq("id", ownerUserId).maybeSingle();
  return {
    userId: ownerUserId,
    email: String((data as { email?: unknown } | null)?.email ?? "").trim().toLowerCase(),
    fullName: String((data as { full_name?: unknown } | null)?.full_name ?? "").trim() || "PropLane",
  };
}

/** Everyone learns of an accepted job: managers by text, the resident by text (else the usual notice), the vendor the address. */
async function announceAcceptance(
  db: SupabaseClient,
  run: DispatchRunRow,
  contact: VendorContact,
  attempt: DispatchAttemptRow,
  scheduledIso: string | null,
  assigned: AssignResult,
  now: Date,
): Promise<void> {
  const whenLabel = scheduledIso ? formatPacificShort(new Date(scheduledIso), now) : attempt.proposed_time || run.details.whenLabel || null;
  const trade = tradeDefinition(run.trade);

  await notifyOutcome(db, run, composeManagerAcceptedText({ handle: run.handle, vendorName: contact.name, whenLabel }), "accepted");

  await textVendor(
    db,
    run,
    contact,
    attempt.id,
    composeVendorConfirmText({ handle: run.handle, details: run.details, whenLabel }),
    "confirm",
  );

  const residentEmail = (run.resident_email ?? "").trim().toLowerCase();
  if (!residentEmail) return;
  const residentText = composeResidentAcceptedText({
    vendorName: contact.name,
    tradeLabel: trade?.label ?? "vendor",
    whenLabel: scheduledIso ? formatPacificShort(new Date(scheduledIso), now) : null,
  });
  const texted = await sendResidentDispatchText(db, {
    ownerUserId: run.owner_user_id,
    workspaceId: run.workspace_id,
    residentEmail,
    text: residentText,
    dedupeKey: `dispatch-resident-accepted-${run.id}`,
  }).catch(() => ({ ok: false as const, reason: "send_failed" }));

  if (run.source_type === "work_order" && assigned === "assigned") {
    const { data: record } = await db
      .from("portal_work_order_records")
      .select("row_data")
      .eq("id", run.source_id)
      .eq("manager_user_id", run.owner_user_id)
      .maybeSingle();
    const row = (record as { row_data?: DemoManagerWorkOrderRow } | null)?.row_data;
    if (row) {
      const sender = await ownerSender(db, run.owner_user_id);
      await workOrderEvent(db, {
        eventId: `${run.source_id}:${scheduledIso ? "scheduled" : "accepted"}:dispatch-run:${run.id}`,
        event: scheduledIso ? "scheduled" : "accepted",
        managerUserId: run.owner_user_id,
        workOrderId: run.source_id,
        senderUserId: sender.userId,
        senderEmail: sender.email,
        senderName: sender.fullName,
        facts: {
          reference: row.reference || "Work order",
          propertyId: row.assignedPropertyId || row.propertyId || undefined,
          title: row.title || "Work order",
          propertyLabel: row.propertyName || undefined,
          scheduledFor: scheduledIso ? formatPacificDateTime(scheduledIso) : undefined,
          vendorName: contact.name,
          emergency: row.priority === "Emergency",
        },
        // The vendor was just texted directly; the resident only gets the usual notice when the text could not go.
        recipients: texted.ok ? [] : [{ audience: "resident" as const, email: residentEmail }],
      }).catch(() => undefined);
    }
  }
}

/**
 * Claim the job for this attempt. Exactly one caller wins the run (`offering|exhausted` ->
 * `accepted`); everyone else is "taken". On a conflict with a service somebody assigned in
 * the meantime the claim is unwound and the manager is told.
 */
export async function acceptAttempt(
  db: SupabaseClient,
  run: DispatchRunRow,
  attempt: DispatchAttemptRow,
  input: { timeText?: string | null; priceCents?: number | null; priceApproved?: boolean; rawText?: string | null; now?: Date },
): Promise<VendorAnswerOutcome> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const contacts = await loadVendorContacts(db, run.owner_user_id, [attempt.vendor_directory_id]);
  const contact = contacts.get(attempt.vendor_directory_id);

  const fixedStart = run.details.startIso && !Number.isNaN(Date.parse(run.details.startIso)) ? new Date(run.details.startIso) : null;
  const proposed = fixedStart ?? parseVendorProposedTime(input.timeText, now);
  const scheduledIso = proposed ? proposed.toISOString() : null;
  const agreed = input.priceCents ?? run.pay_cents ?? null;

  const { data: claimed } = await db
    .from("vendor_dispatch_runs")
    .update({
      status: "accepted",
      accepted_vendor_directory_id: attempt.vendor_directory_id,
      accepted_at: nowIso,
      scheduled_for: scheduledIso,
      agreed_cents: agreed,
      updated_at: nowIso,
    })
    .eq("id", run.id)
    .eq("owner_user_id", run.owner_user_id)
    .in("status", ["offering", "exhausted"])
    .select("id");
  if (!claimed || (claimed as unknown[]).length === 0) {
    // Lost the race (or the manager canceled): this vendor is told once, and their own attempt closes.
    // Only the writer that actually closes the attempt sends the text, so the winner's sweep and the
    // loser's own path can never both tell the same vendor.
    const { data: closed } = await db
      .from("vendor_dispatch_attempts")
      .update({ status: "superseded", responded_at: nowIso, response_text: (input.rawText ?? "").slice(0, 200) || null, timeout_at: null })
      .eq("id", attempt.id)
      .in("status", ["offered", "timed_out"])
      .select("id");
    if (closed && (closed as unknown[]).length > 0) {
      await textVendor(db, run, contact, attempt.id, composeVendorTakenText(run.handle), "taken");
    }
    return { outcome: "taken" };
  }

  await db
    .from("vendor_dispatch_attempts")
    .update({
      status: "accepted",
      responded_at: nowIso,
      response_text: (input.rawText ?? "").slice(0, 200) || null,
      proposed_time: input.timeText ? input.timeText.slice(0, 80) : null,
      timeout_at: null,
      ...(input.priceCents != null ? { quote_cents: input.priceCents, quote_status: input.priceApproved ? "approved" : null } : {}),
    })
    .eq("id", attempt.id);

  // Everyone else still in play is told it was taken, and their portal offer is withdrawn.
  const attempts = await loadAttempts(db, run.id);
  const others = attempts.filter((other) => other.id !== attempt.id);
  const otherContacts = await loadVendorContacts(db, run.owner_user_id, others.map((other) => other.vendor_directory_id));
  for (const other of others) {
    if (other.status === "offered") {
      const { data: closed } = await db
        .from("vendor_dispatch_attempts")
        .update({ status: "superseded", responded_at: nowIso, timeout_at: null })
        .eq("id", other.id)
        .eq("status", "offered")
        .select("id");
      if (closed && (closed as unknown[]).length > 0) {
        await textVendor(db, run, otherContacts.get(other.vendor_directory_id), other.id, composeVendorTakenText(run.handle), "taken");
      }
    } else if (other.status === "queued") {
      await db.from("vendor_dispatch_attempts").update({ status: "canceled" }).eq("id", other.id).eq("status", "queued");
    }
  }
  await withdrawOtherOffers(db, run, attempt.vendor_directory_id, nowIso);

  const accepted = { ...run, status: "accepted" as const, scheduled_for: scheduledIso, agreed_cents: agreed };
  let assigned: AssignResult = "skipped";
  if (contact) assigned = await assignWorkOrderForRun(db, accepted, contact, scheduledIso, now);

  if (assigned === "conflict" || assigned === "error") {
    // Someone else owns the service now (or it vanished): unwind so nothing looks booked that is not.
    await db
      .from("vendor_dispatch_runs")
      .update({ status: "canceled", updated_at: nowIso })
      .eq("id", run.id)
      .eq("status", "accepted");
    await db
      .from("vendor_dispatch_attempts")
      .update({ status: "canceled", response_text: `assign_${assigned}` })
      .eq("id", attempt.id);
    await textVendor(db, run, contact, attempt.id, composeVendorTakenText(run.handle), "taken-conflict");
    await notifyOutcome(
      db,
      run,
      toGsm7(`#${run.handle} was already assigned elsewhere, so ${contact?.firstName ?? "the vendor"}'s yes was not booked`),
      "assign-conflict",
    );
    await recordDispatchEvent(db, { ownerUserId: run.owner_user_id, runId: run.id, handle: run.handle, event: "canceled", key: "assign-conflict", detail: { assigned }, now });
    return { outcome: "taken" };
  }

  await recordDispatchEvent(db, {
    ownerUserId: run.owner_user_id,
    runId: run.id,
    handle: run.handle,
    event: "vendor_accepted",
    key: attempt.id,
    reply: input.rawText ?? null,
    detail: { vendorDirectoryId: attempt.vendor_directory_id, scheduledIso, agreedCents: agreed, assigned },
    now,
  });
  if (contact) await announceAcceptance(db, accepted, contact, attempt, scheduledIso, assigned, now);
  return { outcome: "accepted", scheduledIso };
}

/**
 * A vendor said YES. Over the cap (or any price when no cap was set) the manager is asked
 * first and the vendor is told it is being checked; otherwise the job is theirs.
 */
export async function recordVendorYes(
  db: SupabaseClient,
  input: {
    ownerUserId: string;
    attemptId: string;
    timeText?: string | null;
    priceCents?: number | null;
    rawText?: string | null;
    now?: Date;
  },
): Promise<VendorAnswerOutcome> {
  const now = input.now ?? new Date();
  const attempt = await loadAttempt(db, input.attemptId);
  if (!attempt) return { outcome: "not_found" };
  const run = await loadRun(db, attempt.run_id);
  if (!run || run.owner_user_id !== input.ownerUserId) return { outcome: "not_found" };
  if (run.status === "accepted") {
    if (attempt.status === "accepted") return { outcome: "ignored" };
    if (attempt.status === "offered" || attempt.status === "timed_out") {
      const contacts = await loadVendorContacts(db, run.owner_user_id, [attempt.vendor_directory_id]);
      const { data: closed } = await db
        .from("vendor_dispatch_attempts")
        .update({ status: "superseded", responded_at: now.toISOString() })
        .eq("id", attempt.id)
        .in("status", ["offered", "timed_out"])
        .select("id");
      if (closed && (closed as unknown[]).length > 0) {
        await textVendor(db, run, contacts.get(attempt.vendor_directory_id), attempt.id, composeVendorTakenText(run.handle), "taken");
      }
      return { outcome: "taken" };
    }
    return { outcome: "closed" };
  }
  if (run.status !== "offering" && run.status !== "exhausted") return { outcome: "closed" };
  if (attempt.status !== "offered" && attempt.status !== "timed_out") return { outcome: "ignored" };

  const price = input.priceCents ?? null;
  const cap = run.nte_cents ?? run.pay_cents ?? null;
  if (price != null && (cap == null || price > cap)) {
    const nowIso = now.toISOString();
    const { data: held } = await db
      .from("vendor_dispatch_attempts")
      .update({ status: "offered", quote_cents: price, quote_status: "pending", responded_at: nowIso, response_text: (input.rawText ?? "").slice(0, 200) || null, timeout_at: null })
      .eq("id", attempt.id)
      .in("status", ["offered", "timed_out"])
      .select("id");
    if (!held || (held as unknown[]).length === 0) return { outcome: "ignored" };
    // A held quote re-opens a run the sweep had already given up on, so the manager's answer lands on a live run.
    if (run.status === "exhausted") {
      await db.from("vendor_dispatch_runs").update({ status: "offering", exhausted_at: null, updated_at: nowIso }).eq("id", run.id).eq("status", "exhausted");
    }
    await db.from("vendor_dispatch_runs").update({ approval_reminded_at: null, approval_escalated_at: null, updated_at: nowIso }).eq("id", run.id);
    const contacts = await loadVendorContacts(db, run.owner_user_id, [attempt.vendor_directory_id]);
    const contact = contacts.get(attempt.vendor_directory_id);
    await notifyApprovers(db, { ...run, status: "offering" }, {
      audience: "everyone",
      text: composeQuoteAskText({ handle: run.handle, vendorName: contact?.name ?? "Vendor", quoteCents: price, capCents: cap }),
      key: `quote-${attempt.id}`,
    });
    await textVendor(db, run, contact, attempt.id, composeVendorQuoteHeldText(run.handle), "quote-held");
    await recordDispatchEvent(db, { ownerUserId: run.owner_user_id, runId: run.id, handle: run.handle, event: "quote_held", key: attempt.id, reply: input.rawText ?? null, detail: { quoteCents: price, capCents: cap }, now });
    return { outcome: "quote_held" };
  }
  return acceptAttempt(db, run, attempt, { timeText: input.timeText, priceCents: price, rawText: input.rawText, now });
}

/** The manager's Y / N on a vendor's held quote (SMS or portal). */
export async function decideVendorQuote(
  db: SupabaseClient,
  input: { ownerUserId: string; actorUserId: string; runId: string; approve: boolean; rawText?: string | null; channel: "sms" | "portal"; now?: Date },
): Promise<{ ok: true; outcome: VendorAnswerOutcome } | { ok: false; reason: "not_found" | "not_allowed" | "wrong_state" }> {
  const now = input.now ?? new Date();
  const run = await loadRun(db, input.runId);
  if (!run || run.owner_user_id !== input.ownerUserId) return { ok: false, reason: "not_found" };
  if (!(await canActorApprove(db, run, input.actorUserId))) return { ok: false, reason: "not_allowed" };
  if (run.status !== "offering") return { ok: false, reason: "wrong_state" };
  const attempts = await loadAttempts(db, run.id);
  const held = attempts.find((attempt) => attempt.status === "offered" && attempt.quote_status === "pending");
  if (!held || held.quote_cents == null) return { ok: false, reason: "wrong_state" };

  if (!input.approve) {
    const { data: rejected } = await db
      .from("vendor_dispatch_attempts")
      .update({ status: "declined", quote_status: "rejected", responded_at: now.toISOString() })
      .eq("id", held.id)
      .eq("quote_status", "pending")
      .select("id");
    if (!rejected || (rejected as unknown[]).length === 0) return { ok: false, reason: "wrong_state" };
    const contacts = await loadVendorContacts(db, run.owner_user_id, [held.vendor_directory_id]);
    await textVendor(db, run, contacts.get(held.vendor_directory_id), held.id, composeVendorQuoteDeclinedText(run.handle), "quote-no");
    await recordDispatchEvent(db, { ownerUserId: run.owner_user_id, runId: run.id, handle: run.handle, event: "quote_rejected", actorUserId: input.actorUserId, channel: input.channel, key: held.id, reply: input.rawText ?? null, now });
    await advanceRun(db, run.id, now);
    return { ok: true, outcome: { outcome: "declined" } };
  }

  const { data: approved } = await db
    .from("vendor_dispatch_attempts")
    .update({ quote_status: "approved" })
    .eq("id", held.id)
    .eq("quote_status", "pending")
    .select("id");
  if (!approved || (approved as unknown[]).length === 0) return { ok: false, reason: "wrong_state" };
  await recordDispatchEvent(db, { ownerUserId: run.owner_user_id, runId: run.id, handle: run.handle, event: "quote_approved", actorUserId: input.actorUserId, channel: input.channel, key: held.id, reply: input.rawText ?? null, detail: { quoteCents: held.quote_cents }, now });
  const outcome = await acceptAttempt(db, run, { ...held, quote_status: "approved" }, {
    timeText: held.proposed_time,
    priceCents: held.quote_cents,
    priceApproved: true,
    rawText: held.response_text,
    now,
  });
  return { ok: true, outcome };
}

export async function recordVendorNo(
  db: SupabaseClient,
  input: { ownerUserId: string; attemptId: string; rawText?: string | null; now?: Date },
): Promise<VendorAnswerOutcome> {
  const now = input.now ?? new Date();
  const attempt = await loadAttempt(db, input.attemptId);
  if (!attempt) return { outcome: "not_found" };
  const run = await loadRun(db, attempt.run_id);
  if (!run || run.owner_user_id !== input.ownerUserId) return { outcome: "not_found" };
  if (run.status !== "offering" && run.status !== "exhausted") return { outcome: "closed" };
  const { data: changed } = await db
    .from("vendor_dispatch_attempts")
    .update({ status: "declined", responded_at: now.toISOString(), response_text: (input.rawText ?? "").slice(0, 200) || null, timeout_at: null })
    .eq("id", attempt.id)
    .in("status", ["offered", "timed_out"])
    .select("id");
  if (!changed || (changed as unknown[]).length === 0) return { outcome: "ignored" };
  await declineWorkOrderOffer(db, run, attempt, now);
  const contacts = await loadVendorContacts(db, run.owner_user_id, [attempt.vendor_directory_id]);
  await textVendor(db, run, contacts.get(attempt.vendor_directory_id), attempt.id, composeVendorDeclinedAck(run.handle), "declined-ack");
  await recordDispatchEvent(db, { ownerUserId: run.owner_user_id, runId: run.id, handle: run.handle, event: "vendor_declined", key: attempt.id, reply: input.rawText ?? null, now });
  await advanceRun(db, run.id, now);
  return { outcome: "declined" };
}

export async function recordVendorBusy(
  db: SupabaseClient,
  input: { ownerUserId: string; attemptId: string; minutes: number; rawText?: string | null; now?: Date },
): Promise<VendorAnswerOutcome> {
  const now = input.now ?? new Date();
  const attempt = await loadAttempt(db, input.attemptId);
  if (!attempt) return { outcome: "not_found" };
  const run = await loadRun(db, attempt.run_id);
  if (!run || run.owner_user_id !== input.ownerUserId) return { outcome: "not_found" };
  if (run.status !== "offering" && run.status !== "exhausted") return { outcome: "closed" };
  const busyUntil = new Date(now.getTime() + input.minutes * 60_000).toISOString();
  const { data: changed } = await db
    .from("vendor_dispatch_attempts")
    .update({ status: "busy", busy_until: busyUntil, responded_at: now.toISOString(), response_text: (input.rawText ?? "").slice(0, 200) || null, timeout_at: null })
    .eq("id", attempt.id)
    .in("status", ["offered", "timed_out"])
    .select("id");
  if (!changed || (changed as unknown[]).length === 0) return { outcome: "ignored" };
  await declineWorkOrderOffer(db, run, attempt, now);
  const contacts = await loadVendorContacts(db, run.owner_user_id, [attempt.vendor_directory_id]);
  await textVendor(db, run, contacts.get(attempt.vendor_directory_id), attempt.id, composeVendorBusyAck(run.handle, input.minutes), "busy-ack");
  await recordDispatchEvent(db, { ownerUserId: run.owner_user_id, runId: run.id, handle: run.handle, event: "vendor_busy", key: attempt.id, reply: input.rawText ?? null, detail: { busyUntil }, now });
  await advanceRun(db, run.id, now);
  return { outcome: "busy" };
}

/** Mirror a text decline onto the vendor-portal offer so both surfaces say the same thing. */
async function declineWorkOrderOffer(db: SupabaseClient, run: DispatchRunRow, attempt: DispatchAttemptRow, now: Date): Promise<void> {
  if (run.source_type !== "work_order") return;
  await db
    .from("work_order_vendor_offers")
    .update({ status: "declined", updated_at: now.toISOString() })
    .eq("work_order_id", run.source_id)
    .eq("manager_user_id", run.owner_user_id)
    .eq("vendor_directory_id", attempt.vendor_directory_id)
    .eq("status", "sent")
    .then(undefined, () => undefined);
}

/**
 * An offer past its deadline (sequential: move on; the vendor may still say YES until
 * someone else does). A held quote never times out.
 */
export async function timeoutAttempt(db: SupabaseClient, attemptId: string, now: Date = new Date()): Promise<boolean> {
  const attempt = await loadAttempt(db, attemptId);
  if (!attempt || attempt.status !== "offered" || attempt.quote_status === "pending") return false;
  if (!attempt.timeout_at || Date.parse(attempt.timeout_at) > now.getTime()) return false;
  const run = await loadRun(db, attempt.run_id);
  if (!run || run.status !== "offering") return false;
  const { data: changed } = await db
    .from("vendor_dispatch_attempts")
    .update({ status: "timed_out", responded_at: now.toISOString() })
    .eq("id", attempt.id)
    .eq("status", "offered")
    .select("id");
  if (!changed || (changed as unknown[]).length === 0) return false;
  await recordDispatchEvent(db, { ownerUserId: run.owner_user_id, runId: run.id, handle: run.handle, event: "vendor_timed_out", key: attempt.id, now });
  await advanceRun(db, run.id, now);
  return true;
}
