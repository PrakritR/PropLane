import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { fetchManagerSmsConversations, resolveSmsScopeManagerIds } from "@/lib/manager-sms-messages.server";
import { enqueueOwnerSms, dispatchOwnerSmsOutbox } from "@/lib/sms/owner-sms-dispatcher.server";
import { normalizeE164 } from "@/lib/phone-e164";
import { track } from "@/lib/analytics/posthog";
import { MANUAL_SMS_UNKNOWN_MESSAGE } from "@/lib/sms/manual-send-attempt";

type SendResult = { body: Record<string, unknown>; status: number };
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

  const conversations = await fetchManagerSmsConversations(
    db,
    args.actorUserId,
    { provisionWorkNumber: false, ...(args.scopeManagerIds ? { scopeManagerIdsOverride: args.scopeManagerIds } : {}) },
  );
  const toDigits = toPhone.replace(/\D/g, "");
  const replyKey = String(body.conversationKey ?? "").trim();
  // One phone can be two threads. When the client says which one it is replying
  // into, honour that — otherwise a reply typed in the prospect thread gets
  // stamped `resident` (or vice versa) and lands in the other conversation.
  const match = replyKey
    ? conversations.residents.find((r) => r.conversationKey === replyKey)
    : conversations.residents.find((r) => {
        const phoneDigits = String(r.phone ?? "").replace(/\D/g, "");
        if (phoneDigits && (phoneDigits === toDigits || phoneDigits.endsWith(toDigits.slice(-10)))) return true;
        return Boolean(body.residentUserId && r.residentUserId === body.residentUserId);
      });

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
    actorUserId: args.actorUserId,
    recipientPhone: matchedPhone,
    recipientEmail: match?.residentEmail ?? null,
    body: text,
    sendClass: "transactional",
    purpose: "manager_conversation",
    conversationKey: (match?.conversationKey ?? replyKey) || null,
    counterpartyRole: match?.counterpartyRole,
    // Never persist a browser-supplied identity on a cold compose. A linked
    // user id is accepted only after the server matched it to a visible thread.
    recipientUserId: match?.residentUserId ?? null,
    dedupeKey,
  });

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

  const dispatch = await dispatchOwnerSmsOutbox(
    {
      workerId: `manager-route-${args.actorUserId}`,
      outboxId: result.outboxId,
    },
    db,
  );
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
    track("message_sent", args.actorUserId, {
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
