import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeE164 } from "@/lib/phone-e164";
import { readSmsSuppressionState } from "@/lib/sms-consent";
import { ensureApplicationScopedSmsConsent } from "@/lib/sms/application-consent.server";
import { validateTourSmsPurposeAtDispatch } from "@/lib/sms/tour-sms-eligibility.server";
import {
  estimateSmsSegments,
  evaluateManagerSmsNumberSendability,
  quietHoursBlocks,
  type SmsSendClass,
} from "@/lib/sms/number-registration-policy";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { sendSms } from "@/lib/twilio";
import { logManagerSmsMessage } from "@/lib/manager-sms-messages.server";
import { conversationPhoneRef, isSmsCounterpartyRole, type SmsCounterpartyRole } from "@/lib/sms-conversation-identity";
import {
  evaluateManagerCommsBillingGate,
} from "@/lib/comms-billing/eligibility.server";
import { unitPriceCentsForMeter } from "@/lib/comms-billing/rates";
import { reserveCommsCredit, finishCommsCredit } from "@/lib/comms-billing/wallet.server";

const CONVERSATION_DERIVED_TOUR_PURPOSES = new Set([
  "tour_request_received",
  "tour_request_removed",
  "tour_confirmed",
  "tour_rescheduled",
  "tour_canceled",
]);

type RuntimeRow = {
  mode: string;
  pilot_manager_user_ids: string[] | null;
};

type NumberRow = {
  manager_user_id: string;
  phone_number: string | null;
  phone_number_sid: string | null;
  messaging_service_sid: string | null;
  campaign_sid: string | null;
  provision_state: string;
  registration_state: string;
  registration_ref: string | null;
  attachment_state: string | null;
  number_registration_state: string | null;
  grace_started_at: string | null;
  grace_expires_at: string | null;
  quarantined_at: string | null;
  quarantine_reason: string | null;
};

export type OwnerSmsEnqueueInput = {
  managerUserId: string;
  actorUserId: string;
  recipientPhone: string;
  recipientUserId?: string | null;
  recipientEmail?: string | null;
  body: string;
  sendClass: SmsSendClass;
  purpose: string;
  conversationKey?: string | null;
  counterpartyRole?: SmsCounterpartyRole;
  propertyId?: string | null;
  recipientTimezone?: string | null;
  dedupeKey?: string | null;
  traceId?: string | null;
};

type SendPolicy =
  | { allowed: true; fromNumber: string; segmentCount: number; messagingServiceSid: string }
  | { allowed: false; reason: string; deferUntil?: string };

async function loadSendPolicy(
  db: SupabaseClient,
  input: OwnerSmsEnqueueInput,
  now = new Date(),
): Promise<SendPolicy> {
  if (process.env.SMS_RUNTIME_ENABLED?.trim() !== "1") {
    return { allowed: false, reason: "runtime_env_paused" };
  }
  if (process.env.SMS_OUTBOX_SCHEDULER_READY?.trim() !== "1") {
    return { allowed: false, reason: "outbox_scheduler_unready" };
  }

  const ownerId = input.managerUserId.trim();
  const recipient = normalizeE164(input.recipientPhone);
  if (!ownerId || !recipient) return { allowed: false, reason: "invalid_dispatch_identity" };
  const segmentEstimate = estimateSmsSegments(input.body);
  if (segmentEstimate.segmentCount < 1 || segmentEstimate.segmentCount > 10) {
    return { allowed: false, reason: "segment_limit_exceeded" };
  }

  const [{ data: runtime, error: runtimeError }, { data: number, error: numberError }] = await Promise.all([
    db
      .from("sms_runtime_config")
      .select("mode, pilot_manager_user_ids")
      .eq("singleton", true)
      .maybeSingle(),
    db
      .from("manager_sms_numbers")
      .select(
        "manager_user_id, phone_number, phone_number_sid, messaging_service_sid, campaign_sid, provision_state, registration_state, registration_ref, attachment_state, number_registration_state, grace_started_at, grace_expires_at, quarantined_at, quarantine_reason",
      )
      .eq("manager_user_id", ownerId)
      .maybeSingle(),
  ]);
  if (runtimeError || numberError || !runtime || !number) {
    return { allowed: false, reason: "control_plane_unreadable" };
  }

  const runtimeRow = runtime as RuntimeRow;
  const numberRow = number as NumberRow;
  const allowlisted = (runtimeRow.pilot_manager_user_ids ?? []).includes(ownerId);
  const decision = evaluateManagerSmsNumberSendability(
    {
      provisionState: numberRow.provision_state as never,
      phoneNumber: numberRow.phone_number,
      registrationState: numberRow.registration_state as never,
      registrationRef: numberRow.registration_ref,
      attachmentState: numberRow.attachment_state,
      numberRegistrationState: numberRow.number_registration_state,
      graceStartedAt: numberRow.grace_started_at,
      graceExpiresAt: numberRow.grace_expires_at,
      quarantinedAt: numberRow.quarantined_at,
      quarantineReason: numberRow.quarantine_reason,
    },
    { runtimeMode: runtimeRow.mode, managerIsAllowlisted: allowlisted, now },
  );
  if (!decision.sendable) return { allowed: false, reason: decision.reason ?? "number_not_sendable" };

  const expectedServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID?.trim();
  const expectedCampaignSid = process.env.TWILIO_CAMPAIGN_SID?.trim();
  if (
    !expectedServiceSid ||
    !expectedCampaignSid ||
    numberRow.messaging_service_sid !== expectedServiceSid ||
    numberRow.campaign_sid !== expectedCampaignSid ||
    !numberRow.phone_number_sid
  ) {
    return { allowed: false, reason: "provider_identity_mismatch" };
  }

  const billing = await evaluateManagerCommsBillingGate(db, ownerId,
    segmentEstimate.segmentCount * unitPriceCentsForMeter("sms_outbound_segment"));
  if (!billing.allowed) return { allowed: false, reason: `comms_billing_${billing.reason}` };

  const suppression = await readSmsSuppressionState(db, recipient, { userId: input.recipientUserId });
  if (!suppression.ok) return { allowed: false, reason: suppression.error };
  if (suppression.optedOut) return { allowed: false, reason: "recipient_opted_out" };

  if (input.sendClass !== "control") {
    const consent = await ensureApplicationScopedSmsConsent(db, {
      managerUserId: ownerId,
      recipientPhone: recipient,
      recipientEmail: input.recipientEmail,
      recipientUserId: input.recipientUserId,
      purpose: input.purpose,
      sendClass: input.sendClass,
      conversationKey: input.conversationKey,
      messagingServiceSid: expectedServiceSid,
    });
    if (!consent.ok) return { allowed: false, reason: consent.error };
    if (!consent.granted) return { allowed: false, reason: "scoped_consent_missing" };
    // A lifecycle grant may have been queued while its source conversation was
    // valid. Recheck that explicit derivation at the provider boundary.
    if (CONVERSATION_DERIVED_TOUR_PURPOSES.has(input.purpose)) {
      const tourConsent = await validateTourSmsPurposeAtDispatch(db, {
        managerUserId: ownerId,
        guestPhone: recipient,
        purpose: input.purpose,
        conversationKey: input.conversationKey,
        messagingServiceSid: expectedServiceSid,
      });
      if (!tourConsent.ok) return { allowed: false, reason: tourConsent.reason };
    }
  }

  if (quietHoursBlocks(input.sendClass, now, { tz: input.recipientTimezone ?? "America/Los_Angeles", startHour: 21, endHour: 8 })) {
    return { allowed: false, reason: "quiet_hours", deferUntil: new Date(now.getTime() + 60 * 60 * 1000).toISOString() };
  }

  return {
    allowed: true,
    fromNumber: String(numberRow.phone_number),
    segmentCount: segmentEstimate.segmentCount,
    messagingServiceSid: expectedServiceSid,
  };
}

export async function enqueueOwnerSms(
  input: OwnerSmsEnqueueInput,
  db: SupabaseClient = createSupabaseServiceRoleClient(),
): Promise<
  | { ok: true; outboxId: string; status: string; deduplicated: boolean }
  | { ok: false; error: string }
> {
  const body = input.body.trim();
  const recipient = normalizeE164(input.recipientPhone);
  if (!body || body.length > 1600 || !recipient) return { ok: false, error: "invalid_message" };
  if (!input.managerUserId.trim() || !input.actorUserId.trim() || !input.purpose.trim()) {
    return { ok: false, error: "invalid_dispatch_identity" };
  }

  const policy = await loadSendPolicy(db, { ...input, body, recipientPhone: recipient });
  const enqueuePolicy = policy.allowed ? policy : retryableDispatchPolicy(policy);
  // Pauses and rollout allowlists are deliberate operator controls: never
  // accumulate new messages behind them for surprise delivery after re-enable.
  if (
    !enqueuePolicy.allowed &&
    (!enqueuePolicy.deferUntil ||
      enqueuePolicy.reason === "runtime_env_paused" ||
      enqueuePolicy.reason === "runtime_paused" ||
      enqueuePolicy.reason === "outbox_scheduler_unready" ||
      enqueuePolicy.reason === "manager_not_allowlisted")
  ) {
    return { ok: false, error: enqueuePolicy.reason };
  }
  const segments = estimateSmsSegments(body).segmentCount;
  const dedupeKey = input.dedupeKey?.trim() || randomUUID();
  const status = enqueuePolicy.allowed ? "queued" : "deferred";
  const { data, error } = await db
    .from("sms_outbox")
    .insert({
      manager_user_id: input.managerUserId,
      actor_user_id: input.actorUserId,
      recipient_user_id: input.recipientUserId ?? null,
      recipient_email: input.recipientEmail?.trim().toLowerCase() || null,
      recipient_phone: recipient,
      body,
      send_class: input.sendClass,
      purpose: input.purpose,
      conversation_key: input.conversationKey ?? null,
      counterparty_role: input.counterpartyRole ?? null,
      property_id: input.propertyId ?? null,
      recipient_timezone: input.recipientTimezone ?? "America/Los_Angeles",
      dedupe_key: dedupeKey,
      trace_id: input.traceId ?? null,
      segment_count: segments,
      status,
      available_at: enqueuePolicy.allowed ? new Date().toISOString() : enqueuePolicy.deferUntil,
      blocked_reason: enqueuePolicy.allowed ? null : enqueuePolicy.reason,
    })
    .select("id, status")
    .single();
  if (!error && data) return { ok: true, outboxId: String(data.id), status: String(data.status), deduplicated: false };

  const { data: existing } = await db
    .from("sms_outbox")
    .select("id, status")
    .eq("manager_user_id", input.managerUserId)
    .eq("dedupe_key", dedupeKey)
    .maybeSingle();
  return existing
    ? { ok: true, outboxId: String(existing.id), status: String(existing.status), deduplicated: true }
    : { ok: false, error: "outbox_unavailable" };
}

type ClaimedOutboxRow = {
  id: string;
  manager_user_id: string;
  actor_user_id: string | null;
  recipient_user_id: string | null;
  recipient_email: string | null;
  recipient_phone: string;
  body: string;
  send_class: SmsSendClass;
  purpose: string;
  conversation_key: string | null;
  counterparty_role: SmsCounterpartyRole | null;
  property_id: string | null;
  recipient_timezone: string;
  dedupe_key: string;
  trace_id: string | null;
  segment_count: number;
};

/** Only retain an outbox thread key when it still names this exact owner, role,
 * and recipient. The key was server-resolved on enqueue, but a later profile
 * link may prefer a user id over the original prospect phone; rebuilding it
 * here would split the durable thread. */
export type OutboxConversationKeyResolution =
  | { kind: "absent"; conversationKey: null }
  | { kind: "valid"; conversationKey: string }
  | { kind: "invalid"; conversationKey: null };

export function resolveOutboxConversationKey(row: Pick<ClaimedOutboxRow,
  "manager_user_id" | "recipient_phone" | "recipient_user_id" | "counterparty_role" | "conversation_key"
>): OutboxConversationKeyResolution {
  const key = String(row.conversation_key ?? "").trim();
  if (!key) return { kind: "absent", conversationKey: null };
  const role = String(row.counterparty_role ?? "").trim();
  if (!isSmsCounterpartyRole(role)) return { kind: "invalid", conversationKey: null };
  const [owner, keyRole, recipient, ...rest] = key.split(":");
  if (rest.length || !owner || !keyRole || !recipient) return { kind: "invalid", conversationKey: null };
  if (owner !== row.manager_user_id || keyRole !== role) return { kind: "invalid", conversationKey: null };
  const phone = conversationPhoneRef(row.recipient_phone);
  const userId = String(row.recipient_user_id ?? "").trim();
  return recipient === phone || (userId && recipient === userId)
    ? { kind: "valid", conversationKey: key }
    : { kind: "invalid", conversationKey: null };
}

/** Backwards-compatible valid-key projection for callers that only need a key. */
export function validatedOutboxConversationKey(row: Pick<ClaimedOutboxRow,
  "manager_user_id" | "recipient_phone" | "recipient_user_id" | "counterparty_role" | "conversation_key"
>): string | null {
  const resolved = resolveOutboxConversationKey(row);
  return resolved.kind === "valid" ? resolved.conversationKey : null;
}

async function persistSubmittedConversationLog(
  db: SupabaseClient,
  row: ClaimedOutboxRow,
  fromNumber: string,
  messageSid: string,
  priorAttempts = 0,
  claim: { status: "pending" | "failed"; dueAt: string },
): Promise<"persisted" | "failed" | "stale" | "invalid"> {
  const key = resolveOutboxConversationKey(row);
  const now = new Date();
  if (key.kind === "invalid") {
    const { data, error } = await db.from("sms_outbox").update({
      conversation_log_status: "blocked",
      conversation_log_last_error: "invalid_conversation_key",
      conversation_log_next_attempt_at: null,
      updated_at: now.toISOString(),
    }).eq("id", row.id).eq("provider_message_sid", messageSid)
      .eq("conversation_log_status", claim.status)
      .eq("conversation_log_next_attempt_at", claim.dueAt)
      .select("id").maybeSingle();
    return error ? "failed" : data ? "invalid" : "stale";
  }
  // Legacy rows without an explicit key may only use logger derivation from
  // this already trusted, owner-scoped outbox identity. Explicit bad keys never
  // take this path.
  const logged = await logManagerSmsMessage(db, {
    managerUserId: row.manager_user_id,
    residentPhone: row.recipient_phone,
    residentUserId: row.recipient_user_id,
    direction: "outbound",
    body: row.body,
    fromPhone: fromNumber,
    toPhone: row.recipient_phone,
    messageSid,
    source: row.send_class === "automated" ? "automated" : "work_number",
    counterpartyRole: isSmsCounterpartyRole(row.counterparty_role) ? row.counterparty_role : undefined,
    conversationKey: key.conversationKey ?? undefined,
  }).catch(() => false);
  const { data, error } = await db.from("sms_outbox").update(
    logged
      ? { conversation_log_status: "persisted", conversation_log_attempts: priorAttempts + 1, conversation_log_next_attempt_at: null, conversation_log_last_error: null, updated_at: now.toISOString() }
      : { conversation_log_status: "failed", conversation_log_attempts: priorAttempts + 1, conversation_log_next_attempt_at: new Date(now.getTime() + Math.min(60 * 60_000, 5 * 60_000 * 2 ** Math.min(priorAttempts, 3))).toISOString(), conversation_log_last_error: "manager_sms_log_unavailable", updated_at: now.toISOString() },
  ).eq("id", row.id).eq("provider_message_sid", messageSid)
    .eq("conversation_log_status", claim.status)
    .eq("conversation_log_next_attempt_at", claim.dueAt)
    .select("id").maybeSingle();
  if (error) return "failed";
  if (!data) return "stale";
  return logged ? "persisted" : "failed";
}

async function blockOrDeferClaim(
  db: SupabaseClient,
  row: ClaimedOutboxRow,
  policy: Exclude<SendPolicy, { allowed: true }>,
  workerId: string,
): Promise<boolean> {
  const { data, error } = await db
    .from("sms_outbox")
    .update({
      status: policy.deferUntil ? "deferred" : "blocked",
      blocked_reason: policy.reason,
      available_at: policy.deferUntil ?? new Date().toISOString(),
      lease_owner: null,
      lease_expires_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id)
    .eq("lease_owner", workerId)
    .eq("status", "claimed")
    .select("id")
    .maybeSingle();
  return !error && Boolean(data);
}

const CREDIT_UNAVAILABLE_REASON = "credit_unavailable";

function retryableDispatchPolicy(
  policy: Exclude<SendPolicy, { allowed: true }>,
): Exclude<SendPolicy, { allowed: true }> {
  if (policy.deferUntil) return policy;
  const retryable =
    policy.reason === "control_plane_unreadable" ||
    policy.reason.endsWith("_unreadable") ||
    policy.reason === "runtime_env_paused" ||
    policy.reason === "outbox_scheduler_unready" ||
    policy.reason === "runtime_paused" ||
    policy.reason === "manager_not_allowlisted" ||
    policy.reason === "number_not_active" ||
    policy.reason === "number_not_attached" ||
    policy.reason === "number_not_registered" ||
    policy.reason === "provider_identity_mismatch" ||
    policy.reason === "entitlement_plan_unreadable";
  return retryable
    ? { ...policy, deferUntil: new Date(Date.now() + 5 * 60_000).toISOString() }
    : policy;
}

/**
 * Claim and dispatch a bounded batch. Once provider submission starts, an
 * ambiguous error becomes `unknown` and is never automatically retried.
 */
export async function dispatchOwnerSmsOutbox(
  options: { workerId?: string; limit?: number; outboxId?: string } = {},
  db: SupabaseClient = createSupabaseServiceRoleClient(),
): Promise<{
  ok: boolean;
  claimed: number;
  submitted: number;
  blocked: number;
  unknown: number;
  infrastructureErrors: string[];
}> {
  const workerId = options.workerId?.trim() || `sms-${randomUUID()}`;
  // A process can die after the no-retry boundary but before persisting a SID.
  // Make those rows explicitly operator-reviewable instead of leaving them in
  // `submitting` forever; they are never automatically retried.
  const staleCutoff = new Date(Date.now() - 15 * 60_000).toISOString();
  const { error: staleTransitionError } = await db
    .from("sms_outbox")
    .update({
      status: "unknown",
      blocked_reason: "dispatch_outcome_unknown",
      lease_owner: null,
      lease_expires_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("status", "submitting")
    .is("provider_message_sid", null)
    .lt("dispatch_started_at", staleCutoff);
  if (staleTransitionError) {
    return {
      ok: false,
      claimed: 0,
      submitted: 0,
      blocked: 0,
      unknown: 0,
      infrastructureErrors: ["stale_submission_reconciliation_unavailable"],
    };
  }
  const { data, error } = await db.rpc("claim_sms_outbox", {
    p_worker_id: workerId,
    p_limit: options.outboxId ? 1 : Math.max(1, Math.min(options.limit ?? 5, 5)),
    p_lease_seconds: 120,
    p_outbox_id: options.outboxId ?? null,
  });
  if (error) {
    return {
      ok: false,
      claimed: 0,
      submitted: 0,
      blocked: 0,
      unknown: 0,
      infrastructureErrors: ["outbox_claim_unavailable"],
    };
  }
  const rows = (data ?? []) as ClaimedOutboxRow[];
  const result = {
    ok: true,
    claimed: rows.length,
    submitted: 0,
    blocked: 0,
    unknown: 0,
    infrastructureErrors: [] as string[],
  };

  const recordInfrastructureError = (code: string) => {
    result.ok = false;
    if (!result.infrastructureErrors.includes(code)) result.infrastructureErrors.push(code);
  };

  for (const row of rows) {
    const policy = await loadSendPolicy(db, {
      managerUserId: row.manager_user_id,
      actorUserId: row.actor_user_id ?? row.manager_user_id,
      recipientUserId: row.recipient_user_id,
      recipientPhone: row.recipient_phone,
      recipientEmail: row.recipient_email,
      body: row.body,
      sendClass: row.send_class,
      purpose: row.purpose,
      conversationKey: row.conversation_key,
      counterpartyRole: row.counterparty_role ?? undefined,
      propertyId: row.property_id,
      recipientTimezone: row.recipient_timezone,
      dedupeKey: row.dedupe_key,
      traceId: row.trace_id,
    });
    if (!policy.allowed) {
      const nextPolicy = retryableDispatchPolicy(policy);
      const transitioned = await blockOrDeferClaim(db, row, nextPolicy, workerId);
      if (transitioned && !nextPolicy.deferUntil) result.blocked += 1;
      if (!transitioned) recordInfrastructureError("outbox_policy_transition_unavailable");
      continue;
    }

    const { data: priorAttempts } = await db
      .from("sms_delivery_attempts")
      .select("attempt_number")
      .eq("outbox_id", row.id)
      .order("attempt_number", { ascending: false })
      .limit(1);
    const attemptNumber = Number(priorAttempts?.[0]?.attempt_number ?? 0) + 1;
    const { data: attempt, error: attemptError } = await db
      .from("sms_delivery_attempts")
      .insert({ outbox_id: row.id, attempt_number: attemptNumber, state: "submitting" })
      .select("id")
      .single();
    if (attemptError || !attempt) {
      const released = await blockOrDeferClaim(
        db,
        row,
        {
          allowed: false,
          reason: "attempt_ledger_unavailable",
          deferUntil: new Date(Date.now() + 5 * 60_000).toISOString(),
        },
        workerId,
      );
      if (!released) recordInfrastructureError("attempt_ledger_recovery_unavailable");
      continue;
    }

    const dispatchStartedAt = new Date().toISOString();
    const { data: started, error: startError } = await db
      .from("sms_outbox")
      .update({ status: "submitting", dispatch_started_at: dispatchStartedAt, provider_from_phone: policy.fromNumber, updated_at: dispatchStartedAt })
      .eq("id", row.id)
      .eq("lease_owner", workerId)
      .eq("status", "claimed")
      .gt("lease_expires_at", dispatchStartedAt)
      .select("id")
      .maybeSingle();
    if (startError || !started) {
      await db.from("sms_delivery_attempts").update({ state: "pre_dispatch_failed", finished_at: new Date().toISOString() }).eq("id", attempt.id);
      result.blocked += 1;
      recordInfrastructureError("outbox_submit_claim_unavailable");
      continue;
    }

    // The RPC rechecks the claim and reserves once per outbox/UTC day, so a
    // lost response or transient wallet failure cannot spend again on retry.
    const { data: budgetAvailable, error: budgetError } = await db.rpc("spend_sms_outbox_segment_budget", {
      p_outbox_id: row.id,
      p_worker_id: workerId,
    });
    if (budgetError || budgetAvailable !== true) {
      const retryAt = new Date();
      if (budgetError) retryAt.setTime(Date.now() + 5 * 60_000);
      else {
        retryAt.setUTCDate(retryAt.getUTCDate() + 1);
        retryAt.setUTCHours(0, 0, 5, 0);
      }
      const reason = budgetError ? "campaign_budget_unavailable" : "campaign_segment_budget_exhausted";
      const { data: deferred } = await db
        .from("sms_outbox")
        .update({
          status: "deferred",
          available_at: retryAt.toISOString(),
          blocked_reason: reason,
          dispatch_started_at: null,
          lease_owner: null,
          lease_expires_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id)
        .eq("lease_owner", workerId)
        .eq("status", "submitting")
        .select("id")
        .maybeSingle();
      await db
        .from("sms_delivery_attempts")
        .update({ state: "pre_dispatch_failed", finished_at: new Date().toISOString() })
        .eq("id", attempt.id);
      if (!deferred) result.unknown += 1;
      if (!deferred) recordInfrastructureError("campaign_budget_transition_unavailable");
      continue;
    }

    const creditKey = `sms_outbound:${row.id}`;
    const credit = await reserveCommsCredit(db, {
      managerUserId: row.manager_user_id, meter: "sms_outbound_segment",
      quantity: policy.segmentCount, idempotencyKey: creditKey, metadata: { outboxId: row.id },
    }).catch(() => ({ allowed: false as const, reason: CREDIT_UNAVAILABLE_REASON }));
    if (!credit.allowed && credit.reason === CREDIT_UNAVAILABLE_REASON) {
      const { data: deferred } = await db
        .from("sms_outbox")
        .update({
          status: "deferred",
          available_at: new Date(Date.now() + 5 * 60_000).toISOString(),
          blocked_reason: CREDIT_UNAVAILABLE_REASON,
          dispatch_started_at: null,
          lease_owner: null,
          lease_expires_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id)
        .eq("lease_owner", workerId)
        .eq("status", "submitting")
        .select("id")
        .maybeSingle();
      await db.from("sms_delivery_attempts").update({ state: "pre_dispatch_failed", finished_at: new Date().toISOString() }).eq("id", attempt.id);
      if (!deferred) result.unknown += 1;
      if (!deferred) recordInfrastructureError("credit_transition_unavailable");
      continue;
    }
    if (!credit.allowed || credit.duplicate) {
      await db.from("sms_outbox").update({ status: "blocked", blocked_reason: credit.allowed ? "credit_already_reserved" : credit.reason,
        lease_owner: null, lease_expires_at: null, updated_at: new Date().toISOString() }).eq("id", row.id).eq("status", "submitting");
      await db.from("sms_delivery_attempts").update({ state: "pre_dispatch_failed", finished_at: new Date().toISOString() }).eq("id", attempt.id);
      result.blocked += 1;
      continue;
    }

    const sent = await sendSms(row.recipient_phone, row.body, policy.fromNumber, { skipOptOutCheck: true, creditReservationKey: creditKey });
    if (!sent.sent && sent.providerAttempted === false) {
      await finishCommsCredit(db, row.manager_user_id, creditKey, true);
      await db.from("sms_outbox").update({ status: "blocked", blocked_reason: sent.error ?? "provider_unavailable",
        lease_owner: null, lease_expires_at: null, updated_at: new Date().toISOString() }).eq("id", row.id);
      await db.from("sms_delivery_attempts").update({ state: "pre_dispatch_failed", finished_at: new Date().toISOString() }).eq("id", attempt.id);
      result.blocked += 1;
      continue;
    }
    if (!sent.sent || !sent.sid) {
      const providerErrorCode = sent.error?.match(/\b\d{5}\b/)?.[0] ?? null;
      await db
        .from("sms_outbox")
        .update({
          status: "unknown",
          blocked_reason: "provider_submission_outcome_unknown",
          provider_error_code: providerErrorCode,
          lease_owner: null,
          lease_expires_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);
      await db
        .from("sms_delivery_attempts")
        .update({ state: "unknown", provider_error_code: providerErrorCode, finished_at: new Date().toISOString() })
        .eq("id", attempt.id);
      result.unknown += 1;
      continue;
    }

    const { error: attemptPersistError } = await db
      .from("sms_delivery_attempts")
      .update({
        state: "submitted",
        provider_message_sid: sent.sid,
        finished_at: new Date().toISOString(),
      })
      .eq("id", attempt.id);
    const conversationLogDueAt = new Date().toISOString();
    const { data: submittedRow, error: submitPersistError } = await db
      .from("sms_outbox")
      .update({
        status: "submitted",
        provider_message_sid: sent.sid,
        // This marker is persisted with the provider SID before attempting the
        // separate Communication projection. A crash or marker-write failure
        // can therefore be repaired without ever resubmitting the carrier SMS.
        conversation_log_status: "pending",
        conversation_log_attempts: 0,
        conversation_log_next_attempt_at: conversationLogDueAt,
        conversation_log_last_error: null,
        provider_status: "queued",
        provider_status_rank: 10,
        provider_status_at: new Date().toISOString(),
        lease_owner: null,
        lease_expires_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id)
      .select("id")
      .maybeSingle();
    await finishCommsCredit(db, row.manager_user_id, creditKey).catch(() => {
      recordInfrastructureError("credit_settlement_unavailable");
    });
    if (submitPersistError || !submittedRow) {
      // The provider accepted the message. Never resend. If the attempt SID was
      // saved, a callback can still correlate it through the atomic RPC.
      if (attemptPersistError) {
        console.error("sms provider SID persistence failed", { outboxId: row.id });
      }
      result.unknown += 1;
      continue;
    }

    // The carrier already accepted this SID. Logging is independently durable:
    // failure is observable and repairable, but never changes delivery into a resend.
    const projection = await persistSubmittedConversationLog(db, row, policy.fromNumber, sent.sid, 0, {
      status: "pending",
      dueAt: conversationLogDueAt,
    });
    if (projection === "failed") {
      recordInfrastructureError("conversation_log_persistence_unavailable");
    } else if (projection === "invalid") {
      recordInfrastructureError("conversation_log_projection_invalid_identity");
    }

    // A very fast callback may have arrived before the SID was attached to the
    // outbox. Replay the latest durable event now that correlation exists.
    const { data: latestDelivery } = await db
      .from("sms_delivery_events")
      .select("status, status_rank, error_code, provider_occurred_at")
      .eq("message_sid", sent.sid)
      .order("provider_occurred_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latestDelivery) {
      await db.rpc("apply_sms_delivery_status", {
        p_message_sid: sent.sid,
        p_status: latestDelivery.status,
        p_status_rank: latestDelivery.status_rank,
        p_error_code: latestDelivery.error_code,
        p_provider_occurred_at: latestDelivery.provider_occurred_at,
      });
    }
    result.submitted += 1;
  }

  return result;
}

export type UnknownSmsInventory =
  | { ok: true; count: number; outboxIds: string[] }
  | { ok: false; error: string };

type ConversationLogRepairRow = ClaimedOutboxRow & {
  provider_message_sid: string;
  provider_from_phone: string | null;
  conversation_log_attempts: number;
  conversation_log_next_attempt_at: string;
  conversation_log_status: "pending" | "failed";
};

/**
 * Repair only the Communication projection of a carrier-accepted SMS. This
 * never calls Twilio or changes `sms_outbox.status`; `message_sid` makes a
 * retry idempotent even if a process dies after the insert succeeds.
 */
export async function reconcileSubmittedSmsConversationLogs(
  db: SupabaseClient = createSupabaseServiceRoleClient(),
  limit = 50,
): Promise<
  | { ok: true; attempted: number; persisted: number; failed: number }
  | { ok: false; error: "inventory_unavailable" | "claim_unavailable"; attempted: number; persisted: number; failed: number }
> {
  const now = new Date();
  const { data, error: inventoryError } = await db.from("sms_outbox")
    .select("id,manager_user_id,actor_user_id,recipient_user_id,recipient_email,recipient_phone,body,send_class,purpose,conversation_key,counterparty_role,property_id,recipient_timezone,dedupe_key,trace_id,segment_count,provider_message_sid,provider_from_phone,conversation_log_attempts,conversation_log_next_attempt_at")
    .in("status", ["submitted", "sent", "delivered", "failed"])
    .in("conversation_log_status", ["pending", "failed"])
    .not("provider_message_sid", "is", null)
    // A repair must never substitute a current work number for the actual
    // sender. Legacy rows without a snapshot stay out of the automatic queue.
    .not("provider_from_phone", "is", null)
    .lte("conversation_log_next_attempt_at", now.toISOString())
    .order("conversation_log_next_attempt_at", { ascending: true })
    .limit(Math.max(1, Math.min(limit, 100)));
  if (inventoryError) return { ok: false, error: "inventory_unavailable", attempted: 0, persisted: 0, failed: 0 };
  let attempted = 0;
  let persisted = 0;
  let failed = 0;
  for (const candidate of (data ?? []) as ConversationLogRepairRow[]) {
    const due = String(candidate.conversation_log_next_attempt_at ?? "");
    if (!candidate.provider_message_sid || !candidate.provider_from_phone || !due) continue;
    const claimUntil = new Date(now.getTime() + 5 * 60_000).toISOString();
    const { data: claim, error: claimError } = await db.from("sms_outbox")
      .update({ conversation_log_next_attempt_at: claimUntil, updated_at: now.toISOString() })
      .eq("id", candidate.id)
      .eq("conversation_log_status", candidate.conversation_log_status)
      .eq("conversation_log_next_attempt_at", due)
      .select("id")
      .maybeSingle();
    if (claimError) return { ok: false, error: "claim_unavailable", attempted, persisted, failed };
    if (!claim) continue;
    attempted++;
    const projection = await persistSubmittedConversationLog(
      db, candidate, candidate.provider_from_phone ?? "", candidate.provider_message_sid,
      Number(candidate.conversation_log_attempts ?? 0),
      { status: candidate.conversation_log_status, dueAt: claimUntil },
    );
    if (projection === "persisted") persisted++;
    else if (projection === "failed") failed++;
  }
  return { ok: true, attempted, persisted, failed };
}

/**
 * Inventory every terminal/ambiguous submission for the operator monitor.
 * The bounded id list makes alerts actionable without exposing message bodies,
 * recipient data, or other PII. `count` still reports a backlog larger than
 * the returned sample.
 */
export async function loadUnknownSmsInventory(
  db: SupabaseClient = createSupabaseServiceRoleClient(),
  limit = 100,
): Promise<UnknownSmsInventory> {
  const { data, error, count } = await db
    .from("sms_outbox")
    .select("id", { count: "exact" })
    .eq("status", "unknown")
    .order("updated_at", { ascending: true })
    .limit(Math.max(1, Math.min(limit, 100)));
  if (error) return { ok: false, error: error.message };
  const outboxIds = (data ?? [])
    .map((row) => String(row.id ?? "").trim())
    .filter(Boolean);
  return { ok: true, count: count ?? outboxIds.length, outboxIds };
}
