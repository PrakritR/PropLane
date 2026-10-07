import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { fetchManagerSmsConversations, resolveSmsScopeManagerIds } from "@/lib/manager-sms-messages.server";
import { enqueueOwnerSms, dispatchOwnerSmsOutbox } from "@/lib/sms/owner-sms-dispatcher.server";
import { normalizeE164 } from "@/lib/phone-e164";
import { resolveConversationSendLine } from "@/lib/sms/manager-workspace-role.server";
import { track } from "@/lib/analytics/posthog";
import { MANUAL_SMS_UNKNOWN_MESSAGE } from "@/lib/sms/manual-send-attempt";
import type { ManagerSmsResidentConversation } from "@/lib/manager-sms-messages";
import { isVendorCategorySettingsRow, type ManagerVendorRow } from "@/lib/manager-vendors-storage";
import {
  VENDOR_CONVERSATION_PURPOSE,
  VENDOR_TEXT_ATTESTATION_SOURCE,
  buildVendorSenderLine,
  carryVendorConsentToKey,
  readVendorTextConsent,
  recordManagerAttestedVendorConsent,
  recordVendorInboundReplyConsent,
} from "@/lib/sms/vendor-conversation-consent.server";

type SendResult = { body: Record<string, unknown>; status: number };
type DispatchRunner = <T>(run: () => Promise<T>) => Promise<T>;
function response(body: Record<string, unknown>, init?: { status: number }): SendResult {
  return { body, status: init?.status ?? 200 };
}

/** Shared manual/confirmed-assistant SMS send. Re-resolves the destination and
 * edit grant before the existing consent, outbox and delivery-status gates. */
export async function sendManagerConversationSms(db: SupabaseClient, args: {
  actorUserId: string;
  idempotencyKey?: string;
  /** Server-resolved surface scope only; never accept this from the client/model. */
  scopeManagerIds?: string[];
  toPhone?: string;
  text?: string;
  residentUserId?: string | null;
  conversationKey?: string | null;
  /** Filled only by the authorized projection detail route. */
  selectedConversation?: ManagerSmsResidentConversation;
  /**
   * A roster vendor (manager_vendor_records id). The destination is the row's
   * own saved phone, read here; a browser phone must equal it. A cold first
   * text also needs `attestVendorRelationship` (Decide #1, Oct 6).
   */
  vendorRecordId?: string | null;
  attestVendorRelationship?: boolean;
  /** Server-only seam: runs the carrier hand-off (the dispatch) - the local SMS sandbox captures it here. */
  runDispatch?: DispatchRunner;
}): Promise<SendResult> {
  const body = args;
  if (args.scopeManagerIds && !args.scopeManagerIds.length) {
    return response({ error: "No conversation edit access." }, { status: 403 });
  }
  const text = String(body.text ?? "").trim();
  if (!text)
    return response({ error: "Enter a message." }, { status: 400 });
  if (text.length > 1600) {
    return response(
      { error: "Message is too long (max 1600 characters)." },
      { status: 400 },
    );
  }

  const toPhone = normalizeE164(String(body.toPhone ?? "").trim());
  if (!toPhone)
    return response(
      { error: "Enter a valid US phone number." },
      { status: 400 },
    );

  if (args.vendorRecordId && !args.selectedConversation) {
    return sendRosterVendorText(db, args, { text, toPhone });
  }

  const conversations = args.selectedConversation ? null : await fetchManagerSmsConversations(
    db,
    args.actorUserId,
    { provisionWorkNumber: false, visibility: "edit", ...(args.scopeManagerIds ? { scopeManagerIdsOverride: args.scopeManagerIds } : {}) },
  );
  const toDigits = toPhone.replace(/\D/g, "");
  const replyKey = String(body.conversationKey ?? "").trim();
  // One phone can be two threads. When the client says which one it is replying
  // into, honour that — otherwise a reply typed in the prospect thread gets
  // stamped `resident` (or vice versa) and lands in the other conversation.
  const match = args.selectedConversation ?? (replyKey
    ? conversations?.residents.find((r) => r.conversationKey === replyKey)
    : conversations?.residents.find((r) => {
        const phoneDigits = String(r.phone ?? "").replace(/\D/g, "");
        if (phoneDigits && (phoneDigits === toDigits || phoneDigits.endsWith(toDigits.slice(-10)))) return true;
        return Boolean(body.residentUserId && r.residentUserId === body.residentUserId);
      }));

  if (!match) {
    return response(
      {
        error:
          "Choose a resident or applicant who has opted in to PropLane texts.",
      },
      { status: 409 },
    );
  }

  // The conversation supplies the authoritative destination. A browser may
  // identify a visible thread, but it may not pair that thread's resident id,
  // email or consent evidence with a different phone number.
  const matchedPhone = normalizeE164(String(match.phone ?? "").trim());
  if (!matchedPhone || matchedPhone !== toPhone) {
    return response(
      { error: "The recipient no longer matches this conversation. Refresh and try again." },
      { status: 409 },
    );
  }

  // The server-resolved conversation also owns manager/co-manager scope.
  const ownerManagerUserId =
    String(match.ownerManagerUserId ?? args.actorUserId).trim() || args.actorUserId;
  if (args.selectedConversation && (!match.workLineId || match.sendDisabled)) {
    return response({ error: "This conversation cannot be sent from an active work number." }, { status: 409 });
  }
  if (ownerManagerUserId !== args.actorUserId) {
    const editScope = await resolveSmsScopeManagerIds(
      db,
      args.actorUserId,
      "edit",
    );
    if (!editScope.includes(ownerManagerUserId)) {
      return response(
        { error: "You do not have edit access to this conversation." },
        { status: 403 },
      );
    }
  }
  // The line a reply leaves on is the conversation's own. A projection thread
  // carries its exact line; any other thread is placed by the number it used or
  // the house it is about. Two lines and no placement is a refusal - never the
  // owner's default workspace number.
  let selectedWorkLineId: string | null = args.selectedConversation ? match.workLineId ?? null : null;
  if (!args.selectedConversation) {
    const linePhones = [...(match.messages ?? [])]
      .reverse()
      .filter((message) => message.source === "work_number")
      .map((message) => (message.direction === "inbound" ? message.toPhone : message.fromPhone));
    const line = await resolveConversationSendLine(db, ownerManagerUserId, {
      linePhones,
      propertyId: match.houses?.[0]?.propertyId ?? null,
    });
    if (!line.ok) {
      return response(
        { error: "This conversation does not say which work number it belongs to. Open it from its workspace and try again." },
        { status: 409 },
      );
    }
    selectedWorkLineId = line.numberId;
  }
  if (match?.counterpartyRole === "vendor") {
    // A vendor who texted before consent was recorded on inbound: their text IS the opt-in.
    await materializeLegacyVendorInboundConsent(db, {
      ownerManagerUserId,
      phone: matchedPhone,
      vendorUserId: match?.residentUserId ?? null,
    });
  }
  const requestedDedupe = args.idempotencyKey?.trim() ?? "";
  const dedupeKey = /^[A-Za-z0-9_-]{16,128}$/.test(requestedDedupe)
    ? `manager:${requestedDedupe}`
    : `manager:${createHash("sha256")
        .update(
          [
            args.actorUserId,
            ownerManagerUserId,
            toPhone,
            match?.conversationKey ?? replyKey,
            text,
            Math.floor(Date.now() / 30_000),
          ].join("|"),
        )
        .digest("hex")}`;
  const result = await enqueueOwnerSms({
    managerUserId: ownerManagerUserId,
    selectedWorkLineId,
    actorUserId: args.actorUserId,
    recipientPhone: matchedPhone,
    recipientEmail: match?.residentEmail ?? null,
    body: text,
    sendClass: "transactional",
    // A vendor thread carries the vendor consent ledger (the vendor's own text
    // or the manager's attestation); every other thread keeps the generic purpose.
    purpose: match?.counterpartyRole === "vendor" ? VENDOR_CONVERSATION_PURPOSE : "manager_conversation",
    conversationKey: (match?.conversationKey ?? replyKey) || null,
    counterpartyRole: match?.counterpartyRole,
    // Never persist a browser-supplied identity on a cold compose. A linked
    // user id is accepted only after the server matched it to a visible thread.
    recipientUserId: match?.residentUserId ?? null,
    dedupeKey,
  });

  return finishEnqueuedSend(db, args.actorUserId, ownerManagerUserId, result, args.runDispatch);
}

type EnqueueResult = Awaited<ReturnType<typeof enqueueOwnerSms>>;

async function finishEnqueuedSend(
  db: SupabaseClient,
  actorUserId: string,
  ownerManagerUserId: string,
  result: EnqueueResult,
  runDispatch?: DispatchRunner,
): Promise<SendResult> {
  if (!result.ok) {
    const userMessage =
      result.error === "recipient_opted_out"
        ? "That number has opted out of texts."
        : result.error === "scoped_consent_missing"
          ? "That person must text your work number or opt in before you can reply."
          : result.error.startsWith("entitlement_")
            ? "Messaging requires an active paid plan."
            : result.error.includes("runtime") ||
                result.error.includes("number_") ||
                result.error.includes("provider_")
              ? "Your work number is not ready to send yet. Open Settings → Messaging for details."
              : "Could not queue SMS.";
    return response(
      { error: userMessage },
      { status: result.error === "scoped_consent_missing" ? 409 : 503 },
    );
  }

  const dispatchNow = () =>
    dispatchOwnerSmsOutbox(
      {
        workerId: `manager-route-${actorUserId}`,
        outboxId: result.outboxId,
      },
      db,
    );
  const dispatch = await (runDispatch ? runDispatch(dispatchNow) : dispatchNow());
  const { data: outbox } = await db
    .from("sms_outbox")
    .select("status, blocked_reason")
    .eq("id", result.outboxId)
    .maybeSingle();
  const outboxStatus = String(outbox?.status ?? result.status);
  if (outboxStatus === "unknown" || dispatch.unknown > 0) {
    return response(
      {
        code: "delivery_outcome_unknown",
        error: MANUAL_SMS_UNKNOWN_MESSAGE,
        outboxId: result.outboxId,
        status: "unknown",
      },
      { status: 409 },
    );
  }
  if (outboxStatus === "blocked" || outboxStatus === "failed") {
    return response(
      {
        error:
          "The SMS could not be submitted. Check Settings → Messaging and try again.",
        outboxId: result.outboxId,
      },
      { status: 503 },
    );
  }
  const responseStatus =
    dispatch.submitted === 1 ||
    ["submitted", "sent", "delivered"].includes(outboxStatus)
      ? "submitted"
      : outboxStatus;
  if (responseStatus === "submitted") {
    track("message_sent", actorUserId, {
      channel: "sms",
      owner_id: ownerManagerUserId,
    });
  }
  return response(
    {
      ok: true,
      outboxId: result.outboxId,
      status: responseStatus,
    },
    { status: responseStatus === "submitted" ? 200 : 202 },
  );
}

type Row = Record<string, unknown>;

/** A vendor who texted this work number first has opted in to replies, whether or not their text was ever recorded as consent. */
async function materializeLegacyVendorInboundConsent(
  db: SupabaseClient,
  input: { ownerManagerUserId: string; phone: string; vendorUserId: string | null },
): Promise<void> {
  try {
    const state = await readVendorTextConsent(db, {
      managerUserId: input.ownerManagerUserId, vendorUserId: input.vendorUserId, phone: input.phone,
    });
    if (!state.ok || state.state !== "none") return;
    const { data } = await db
      .from("inbound_sms_log")
      .select("message_sid")
      .eq("manager_user_id", input.ownerManagerUserId)
      .eq("from_phone", input.phone)
      .order("created_at", { ascending: false })
      .limit(1);
    const sid = String((data as Row[] | null)?.[0]?.message_sid ?? "").trim();
    if (!sid) return;
    await recordVendorInboundReplyConsent(db, {
      managerUserId: input.ownerManagerUserId, vendorUserId: input.vendorUserId, phone: input.phone, messageSid: sid,
    });
  } catch {
    // Best effort: without the grant the dispatcher refuses with the ordinary consent message.
  }
}

/** Has a manager text to this vendor already been accepted for delivery? */
async function hasAcceptedManagerVendorText(
  db: SupabaseClient,
  ownerManagerUserId: string,
  phone: string,
): Promise<boolean> {
  const { data, error } = await db
    .from("sms_outbox")
    .select("id")
    .eq("manager_user_id", ownerManagerUserId)
    .eq("recipient_phone", phone)
    .eq("purpose", VENDOR_CONVERSATION_PURPOSE)
    .like("dedupe_key", "manager:%")
    .in("status", ["queued", "claimed", "deferred", "submitting", "submitted", "sent", "delivered", "unknown"])
    .limit(1);
  // An unreadable history is treated as "not sent yet": a repeated STOP footer is harmless, a missing one is not.
  if (error) return false;
  return ((data as unknown[] | null) ?? []).length > 0;
}

/** The thread a roster vendor already has, if any: its line decides where a new text leaves. */
async function existingVendorThreadLine(
  db: SupabaseClient,
  ownerManagerUserId: string,
  phone: string,
): Promise<string | null> {
  try {
    const { data } = await db
      .from("sms_projection_conversations")
      .select("work_line_id")
      .eq("owner_manager_user_id", ownerManagerUserId)
      .eq("counterparty_role", "vendor")
      .eq("counterparty_phone", phone)
      .is("merged_into_id", null)
      .order("last_event_at", { ascending: false })
      .limit(1);
    return String((data as Row[] | null)?.[0]?.work_line_id ?? "").trim() || null;
  } catch {
    return null;
  }
}

async function senderLineFor(
  db: SupabaseClient,
  actorUserId: string,
  workLineId: string | null,
): Promise<string> {
  let workspaceName: string | null = null;
  let managerFirstName: string | null = null;
  try {
    const { data: actor } = await db.from("profiles").select("full_name").eq("id", actorUserId).maybeSingle();
    managerFirstName = String((actor as Row | null)?.full_name ?? "").trim().split(/\s+/)[0] || null;
    if (workLineId) {
      const { data: line } = await db.from("manager_sms_numbers").select("workspace_id").eq("id", workLineId).maybeSingle();
      const workspaceId = String((line as Row | null)?.workspace_id ?? "").trim();
      if (workspaceId) {
        const { data: workspace } = await db.from("portal_workspaces").select("name").eq("id", workspaceId).maybeSingle();
        workspaceName = String((workspace as Row | null)?.name ?? "").trim() || null;
      }
    }
  } catch {
    // The line falls back to generic words; it is never omitted.
  }
  return buildVendorSenderLine({ managerFirstName, workspaceName });
}

type RosterVendor = {
  recordId: string;
  ownerManagerUserId: string;
  vendor: ManagerVendorRow;
  vendorUserId: string | null;
  /** The vendor row's own saved phone, normalized: the only destination a roster text may use. */
  rosterPhone: string | null;
};

/** Load a roster vendor the actor may text; an error result carries the response to return. */
async function loadRosterVendorForActor(
  db: SupabaseClient,
  args: { actorUserId: string; scopeManagerIds?: string[]; vendorRecordId?: string | null },
): Promise<{ ok: true; value: RosterVendor } | { ok: false; result: SendResult }> {
  const recordId = String(args.vendorRecordId ?? "").trim();
  const fail = (body: Record<string, unknown>, status: number) => ({ ok: false as const, result: response(body, { status }) });
  const { data: record, error } = await db
    .from("manager_vendor_records")
    .select("id, manager_user_id, vendor_user_id, row_data")
    .eq("id", recordId)
    .maybeSingle();
  if (error) return fail({ error: "Could not queue SMS." }, 503);
  const vendor = (record as { row_data?: ManagerVendorRow | null } | null)?.row_data ?? null;
  if (!record || !vendor || isVendorCategorySettingsRow(vendor) || vendor.active === false) {
    return fail({ error: "Vendor not found." }, 404);
  }
  const ownerManagerUserId = String((record as Row).manager_user_id ?? "").trim();
  if (!ownerManagerUserId) return fail({ error: "Vendor not found." }, 404);
  if (args.scopeManagerIds && !args.scopeManagerIds.includes(ownerManagerUserId)) {
    return fail({ error: "You do not have edit access to this conversation." }, 403);
  }
  if (ownerManagerUserId !== args.actorUserId) {
    const editScope = await resolveSmsScopeManagerIds(db, args.actorUserId, "edit");
    if (!editScope.includes(ownerManagerUserId)) {
      return fail({ error: "You do not have edit access to this conversation." }, 403);
    }
  }
  return {
    ok: true,
    value: {
      recordId,
      ownerManagerUserId,
      vendor,
      vendorUserId: String((record as Row).vendor_user_id ?? vendor.vendorUserId ?? "").trim() || null,
      rosterPhone: normalizeE164(String(vendor.phone ?? "").trim()),
    },
  };
}

/**
 * What the New message modal needs before it offers the "I work with this
 * vendor" box: does this vendor still need the manager's attestation, has the
 * number opted out, and what will the first text's identification line say.
 */
export async function readRosterVendorTextStatus(
  db: SupabaseClient,
  args: { actorUserId: string; vendorRecordId: string; scopeManagerIds?: string[] },
): Promise<SendResult> {
  const loaded = await loadRosterVendorForActor(db, args);
  if (!loaded.ok) return loaded.result;
  const { ownerManagerUserId, vendorUserId, rosterPhone } = loaded.value;
  if (!rosterPhone) return response({ error: "Add a phone number to this vendor before texting them." }, { status: 409 });
  const consent = await readVendorTextConsent(db, { managerUserId: ownerManagerUserId, vendorUserId, phone: rosterPhone });
  if (!consent.ok) return response({ error: "Could not read consent." }, { status: 503 });
  const optedOut = consent.state === "opted_out" || consent.state === "revoked";
  const awaitingFirst =
    consent.state === "granted" &&
    consent.grantSource === VENDOR_TEXT_ATTESTATION_SOURCE &&
    !(await hasAcceptedManagerVendorText(db, ownerManagerUserId, rosterPhone));
  const needsAttestation = consent.state === "none";
  const lineId = needsAttestation || awaitingFirst ? await existingVendorThreadLine(db, ownerManagerUserId, rosterPhone) : null;
  return response({
    ok: true,
    phone: rosterPhone,
    needsAttestation,
    optedOut,
    ...(needsAttestation ? { senderLine: await senderLineFor(db, args.actorUserId, lineId ?? (await onlyWorkLineId(db, ownerManagerUserId))) } : {}),
  });
}

/**
 * The same answer for a number with no roster vendor yet (Send to phone on a service): consent is read by
 * phone alone, so a number that already texted STOP shows as opted out before anything is minted.
 */
export async function readPhoneVendorTextStatus(
  db: SupabaseClient,
  args: { actorUserId: string; phone: string },
): Promise<SendResult> {
  const phone = normalizeE164(args.phone);
  if (!phone) return response({ error: "Enter a valid phone number." }, { status: 400 });
  const consent = await readVendorTextConsent(db, { managerUserId: args.actorUserId, vendorUserId: null, phone });
  if (!consent.ok) return response({ error: "Could not read consent." }, { status: 503 });
  const optedOut = consent.state === "opted_out" || consent.state === "revoked";
  const needsAttestation = consent.state === "none";
  return response({
    ok: true,
    phone,
    needsAttestation,
    optedOut,
    ...(needsAttestation
      ? {
          senderLine: await senderLineFor(
            db,
            args.actorUserId,
            (await existingVendorThreadLine(db, args.actorUserId, phone)) ?? (await onlyWorkLineId(db, args.actorUserId)),
          ),
        }
      : {}),
  });
}

async function onlyWorkLineId(db: SupabaseClient, ownerManagerUserId: string): Promise<string | null> {
  const line = await resolveConversationSendLine(db, ownerManagerUserId, { propertyId: null });
  return line.ok ? line.numberId : null;
}

/**
 * A text to a vendor on the manager's roster (manager_vendor_records), with or
 * without a thread. The row's own saved phone is the destination. A cold first
 * text needs the manager's attestation ("I work with this vendor"); it is stored
 * as `vendor_conversation` consent evidence and the message carries the sender
 * line + STOP footer. STOP (any rail) always wins.
 */
async function sendRosterVendorText(
  db: SupabaseClient,
  args: {
    actorUserId: string;
    idempotencyKey?: string;
    scopeManagerIds?: string[];
    vendorRecordId?: string | null;
    attestVendorRelationship?: boolean;
    runDispatch?: DispatchRunner;
  },
  input: { text: string; toPhone: string },
): Promise<SendResult> {
  const loaded = await loadRosterVendorForActor(db, args);
  if (!loaded.ok) return loaded.result;
  const { recordId, ownerManagerUserId, vendor, vendorUserId, rosterPhone } = loaded.value;
  // The vendor's saved phone is the only destination a roster text may use.
  if (!rosterPhone) {
    return response({ error: "Add a phone number to this vendor before texting them." }, { status: 409 });
  }
  if (rosterPhone !== input.toPhone) {
    return response({ error: "The recipient no longer matches this vendor. Refresh and try again." }, { status: 409 });
  }

  const consent = await readVendorTextConsent(db, { managerUserId: ownerManagerUserId, vendorUserId, phone: rosterPhone });
  if (!consent.ok) return response({ error: "Could not queue SMS." }, { status: 503 });
  if (consent.state === "opted_out" || consent.state === "revoked") {
    return response({ error: "That number has opted out of texts." }, { status: 409 });
  }
  const conversationKey = consent.conversationKey;

  let selectedWorkLineId = await existingVendorThreadLine(db, ownerManagerUserId, rosterPhone);
  if (!selectedWorkLineId) {
    const line = await resolveConversationSendLine(db, ownerManagerUserId, { propertyId: null });
    if (!line.ok) {
      return response(
        { error: "This workspace has more than one work number. Open the vendor from its workspace and try again." },
        { status: 409 },
      );
    }
    selectedWorkLineId = line.numberId;
  }

  let text = input.text;
  // The identification + STOP line goes on the FIRST text the vendor receives
  // from this manager: a fresh attestation, or an attestation whose first send
  // never left (no credit, line not ready) - never on later messages.
  const attestedAwaitingFirstText =
    consent.state === "granted" &&
    consent.grantedUnder === conversationKey &&
    consent.grantSource === VENDOR_TEXT_ATTESTATION_SOURCE &&
    !(await hasAcceptedManagerVendorText(db, ownerManagerUserId, rosterPhone));
  if (attestedAwaitingFirstText) {
    text = `${input.text} ${await senderLineFor(db, args.actorUserId, selectedWorkLineId)}`;
    if (text.length > 1600) {
      return response({ error: "Message is too long (max 1600 characters)." }, { status: 400 });
    }
  } else if (consent.state === "none") {
    if (args.attestVendorRelationship !== true) {
      return response(
        { code: "vendor_attestation_required", error: "Confirm you work with this vendor to send the first text." },
        { status: 409 },
      );
    }
    const senderLine = await senderLineFor(db, args.actorUserId, selectedWorkLineId);
    text = `${input.text} ${senderLine}`;
    if (text.length > 1600) {
      return response({ error: "Message is too long (max 1600 characters)." }, { status: 400 });
    }
    const recorded = await recordManagerAttestedVendorConsent(db, {
      managerUserId: ownerManagerUserId, actorUserId: args.actorUserId, phone: rosterPhone,
      conversationKey, vendorRecordId: recordId, senderLine,
    });
    if (!recorded.ok) return response({ error: "Could not queue SMS." }, { status: 503 });
  } else if (consent.grantedUnder && consent.grantedUnder !== conversationKey) {
    const carried = await carryVendorConsentToKey(db, {
      managerUserId: ownerManagerUserId, phone: rosterPhone, conversationKey, fromKey: consent.grantedUnder,
    });
    if (!carried.ok) return response({ error: "Could not queue SMS." }, { status: 503 });
  }

  const requestedDedupe = args.idempotencyKey?.trim() ?? "";
  const dedupeKey = /^[A-Za-z0-9_-]{16,128}$/.test(requestedDedupe)
    ? `manager:${requestedDedupe}`
    : `manager:${createHash("sha256")
        .update([args.actorUserId, ownerManagerUserId, rosterPhone, conversationKey, input.text, Math.floor(Date.now() / 30_000)].join("|"))
        .digest("hex")}`;
  const result = await enqueueOwnerSms({
    managerUserId: ownerManagerUserId,
    selectedWorkLineId,
    actorUserId: args.actorUserId,
    recipientPhone: rosterPhone,
    recipientEmail: String(vendor.email ?? "").trim() || null,
    body: text,
    sendClass: "transactional",
    purpose: VENDOR_CONVERSATION_PURPOSE,
    conversationKey,
    counterpartyRole: "vendor",
    recipientUserId: vendorUserId,
    dedupeKey,
  });
  return finishEnqueuedSend(db, args.actorUserId, ownerManagerUserId, result, args.runDispatch);
}
