import "server-only";

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildConversationKey } from "@/lib/sms-conversation-identity";
import { readScopedSmsConsentState, recordScopedSmsConsent } from "@/lib/sms-consent";
import { dispatchOwnerSmsOutbox, enqueueOwnerSms } from "@/lib/sms/owner-sms-dispatcher.server";

export const PROSPECT_TOUR_REMINDER_PURPOSE = "prospect_tour_followup";
export const PROSPECT_TOUR_REMINDER_BODY =
  "Still interested in a tour? Reply to continue, and I’ll check the latest published opening.";

type DurableFact = {
  tool?: unknown;
  input?: unknown;
  output?: unknown;
  recordedAt?: unknown;
};

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** A reminder is registered only for the current turn's real, published offer
 * and a reply that asks the prospect to choose. The reminder itself never
 * repeats times, so delayed dispatch cannot quote expired availability. */
export function prospectTourReminderEligibility(
  candidateContext: unknown,
  replyBody: string,
): { eligible: true; propertyId: string | null } | { eligible: false } {
  if (!Array.isArray(candidateContext) || !replyBody.trim()) return { eligible: false };
  const facts = candidateContext.filter((item): item is DurableFact => Boolean(object(item)));
  const latestRecordedAt = facts.reduce((latest, fact) => {
    const value = typeof fact.recordedAt === "string" ? fact.recordedAt : "";
    return value > latest ? value : latest;
  }, "");
  const current = latestRecordedAt
    ? facts.filter((fact) => fact.recordedAt === latestRecordedAt)
    : facts;
  if (current.some((fact) => fact.tool === "confirm_prospect_sms_tour" || fact.tool === "escalate_to_manager")) {
    return { eligible: false };
  }
  const availability = [...current].reverse().find((fact) => fact.tool === "list_open_tour_slots");
  const availabilityOutput = object(availability?.output);
  const slots = availabilityOutput?.slots;
  const hasPublishedOffer = availabilityOutput?.publishedOnly === true &&
    availabilityOutput?.resolution === "resolved" && Array.isArray(slots) && slots.length > 0;
  const listingFact = [...current].reverse().find((fact) => fact.tool === "get_listing_details");
  const listingOutput = object(listingFact?.output);
  const listing = object(listingOutput?.listing);
  const hasResolvedListing = listingOutput?.found === true && Boolean(listing);
  const preparedFact = [...current].reverse().find((fact) => fact.tool === "prepare_prospect_tour_confirmation");
  const preparedOutput = object(preparedFact?.output);
  const preparedOffer = object(preparedOutput?.preparedOffer);
  const hasPreparedOffer = Boolean(
    preparedOffer && typeof preparedOffer.slotKey === "string" && typeof preparedOffer.start === "string" &&
    typeof preparedOffer.end === "string" && typeof preparedOffer.hostUserId === "string",
  );
  const asksForSchedulingInput = /\b(name|email|contact|day|time|slot|tour)\b/i.test(replyBody) &&
    /\?|\b(which|choose|pick|reply with|let me know|what(?:'s| is| day| time)|may i have|can i get)\b/i.test(replyBody);
  const asksForPreparedConfirmation = hasPreparedOffer && /\b(confirm|reply(?:ing)? yes)\b/i.test(replyBody);
  if ((!hasPublishedOffer && !hasResolvedListing && !hasPreparedOffer) || (!asksForSchedulingInput && !asksForPreparedConfirmation)) return { eligible: false };
  const input = object(availability?.input);
  const propertyId = typeof input?.propertyId === "string" && input.propertyId.trim()
    ? input.propertyId.trim()
    : typeof object(preparedFact?.input)?.propertyId === "string" && String(object(preparedFact?.input)?.propertyId).trim()
      ? String(object(preparedFact?.input)?.propertyId).trim()
    : typeof listing?.propertyId === "string" && listing.propertyId.trim()
      ? listing.propertyId.trim()
      : null;
  if (!propertyId) return { eligible: false };
  return { eligible: true, propertyId };
}

export async function registerProspectTourReminder(
  db: SupabaseClient,
  args: {
    burstId: string;
    burstRevision: number;
    managerUserId: string;
    recipientPhoneE164: string;
    candidateContext: unknown;
    replyBody: string;
    traceId?: string | null;
  },
): Promise<{ registered: boolean; reason?: string }> {
  const eligibility = prospectTourReminderEligibility(args.candidateContext, args.replyBody);
  if (!eligibility.eligible) return { registered: false, reason: "not_awaiting_exact_selection" };
  const conversationKey = buildConversationKey({
    ownerManagerUserId: args.managerUserId,
    role: "prospect",
    counterpartyPhone: args.recipientPhoneE164,
  });
  const consentScope = {
    managerUserId: args.managerUserId,
    purpose: PROSPECT_TOUR_REMINDER_PURPOSE,
    sendClass: "automated" as const,
    conversationKey,
    messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID?.trim() || null,
  };
  const current = await readScopedSmsConsentState(db, args.recipientPhoneE164, consentScope);
  if (!current.ok) return { registered: false, reason: current.error };
  if (current.state === "revoked") return { registered: false, reason: "scoped_consent_revoked" };
  if (current.state === "none") {
    const recorded = await recordScopedSmsConsent(db, args.recipientPhoneE164, {
      ...consentScope,
      eventType: "granted",
      source: "recipient_initiated_tour_scheduling",
      evidence: { burstId: args.burstId, burstRevision: args.burstRevision },
    });
    if (!recorded.ok) return { registered: false, reason: recorded.error };
  }
  const { data, error } = await db.rpc("register_prospect_sms_tour_reminder", {
    p_burst_id: args.burstId,
    p_burst_revision: args.burstRevision,
    p_manager_user_id: args.managerUserId,
    p_conversation_key: conversationKey,
    p_recipient_phone_e164: args.recipientPhoneE164,
    p_property_id: eligibility.propertyId,
    p_trace_id: args.traceId?.trim() || null,
  });
  if (error || data !== true) return { registered: false, reason: "reminder_attempt_stale" };
  return { registered: true };
}

type ClaimedReminder = {
  id: string;
  burst_id: string;
  burst_revision: number;
  manager_user_id: string;
  conversation_key: string;
  recipient_phone_e164: string;
  property_id: string | null;
  trace_id: string | null;
};

async function complete(
  db: SupabaseClient,
  reminderId: string,
  workerId: string,
  status: "enqueued" | "scheduled" | "cancelled" | "blocked",
  outboxId?: string | null,
  reason?: string | null,
): Promise<boolean> {
  const { data, error } = await db.rpc("complete_prospect_sms_tour_reminder", {
    p_reminder_id: reminderId,
    p_worker_id: workerId,
    p_status: status,
    p_outbox_id: outboxId ?? null,
    p_reason: reason ?? null,
  });
  return !error && data === true;
}

/** Claims due jobs with a lease, reuses the owner outbox's consent/quiet-hour
 * policy, and records the outbox handoff before another worker may retry. */
export async function dispatchProspectTourReminders(
  db: SupabaseClient,
  options: { workerId?: string; limit?: number } = {},
): Promise<{ claimed: number; enqueued: number; cancelled: number; retried: number; failed: number }> {
  const workerId = options.workerId?.trim() || `prospect-tour-reminder-${randomUUID()}`;
  const { data, error } = await db.rpc("claim_prospect_sms_tour_reminders", {
    p_worker_id: workerId,
    p_limit: Math.max(1, Math.min(options.limit ?? 10, 20)),
    p_lease_seconds: 120,
  });
  if (error) throw new Error("prospect_tour_reminder_claim_unavailable");
  const rows = (data ?? []) as ClaimedReminder[];
  const result = { claimed: rows.length, enqueued: 0, cancelled: 0, retried: 0, failed: 0 };
  for (const row of rows) {
    const sent = await enqueueOwnerSms({
      managerUserId: row.manager_user_id,
      actorUserId: row.manager_user_id,
      recipientPhone: row.recipient_phone_e164,
      body: PROSPECT_TOUR_REMINDER_BODY,
      sendClass: "automated",
      purpose: PROSPECT_TOUR_REMINDER_PURPOSE,
      conversationKey: row.conversation_key,
      counterpartyRole: "prospect",
      propertyId: row.property_id,
      recipientTimezone: "America/Los_Angeles",
      dedupeKey: `prospect-tour-reminder:${row.burst_id}:${row.burst_revision}`,
      traceId: row.trace_id,
      prospectTourReminderId: row.id,
    }, db);
    if (sent.ok) {
      if (await complete(db, row.id, workerId, "enqueued", sent.outboxId)) {
        result.enqueued += 1;
        await dispatchOwnerSmsOutbox({
          workerId: `${workerId}-outbox`,
          outboxId: sent.outboxId,
        }, db);
      } else result.failed += 1;
      continue;
    }
    const terminal = [
      "recipient_opted_out",
      "scoped_consent_missing",
      "scoped_consent_revoked",
      "invalid_message",
      "invalid_dispatch_identity",
    ].includes(sent.error);
    if (terminal) {
      if (await complete(db, row.id, workerId, "cancelled", null, sent.error)) result.cancelled += 1;
      else result.failed += 1;
      continue;
    }
    if (await complete(db, row.id, workerId, "scheduled", null, sent.error)) result.retried += 1;
    else result.failed += 1;
  }
  return result;
}
