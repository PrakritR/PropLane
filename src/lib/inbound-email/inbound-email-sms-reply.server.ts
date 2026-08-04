/**
 * Emailed replies → SMS conversations.
 *
 * An inbound-text notification email carries a signed `sms+…` Reply-To
 * (reply-address.server.ts). When a manager answers that email, the reply
 * lands here: the token resolves the (manager, counterparty phone)
 * conversation, the quoted history is stripped, and the new text is sent
 * onward as an SMS from the manager's work number — then logged into the SAME
 * `manager_sms_messages` conversation so the portal thread shows the reply.
 *
 * Idempotency: Resend redelivers on non-2xx and can double-deliver, and an
 * SMS send is not idempotent on its own — so the reply CLAIMS a
 * `portal_outbound_mail_records` row keyed on the Resend email id BEFORE
 * sending (the weekly-rent-reminder pattern). A redelivery loses the claim and
 * never texts twice.
 *
 * Honesty: a failed send is reported back to the manager as a bounce email —
 * never logged as sent, never silently dropped.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  fetchResendReceivedEmailBody,
  fetchResendReceivedEmailBodyWithRetry,
  htmlToText,
  type ParsedInboundEmail,
  type ResendReceivedEmailHeaders,
} from "@/lib/inbound-email/inbound-email.server";
import {
  assessInboundEmailAuthentication,
  type InboundEmailAuthOutcome,
} from "@/lib/inbound-email/email-authentication";
import { stripEmailReplyQuote } from "@/lib/inbound-email/inbound-email-reply.server";
import {
  consumeSmsEmailReplyGrant,
  smsEmailReplyBounceRateLimitKey,
  smsEmailReplyRateLimitKey,
} from "@/lib/inbound-email/sms-reply-grant.server";
import { rateLimit } from "@/lib/rate-limit";
import { logManagerSmsMessage } from "@/lib/manager-sms-messages.server";
import { sendFromManagerWorkNumber } from "@/lib/proplane-sms-transport.server";
import {
  CO_MANAGER_SMS_EMAIL_PORTAL_ONLY_COPY,
  sendManagerNoticeEmail,
} from "@/lib/sms-inbox-notice.server";
import {
  coerceCounterpartyRole,
  type SmsCounterpartyRole,
} from "@/lib/sms-conversation-identity";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { PRODUCTION_APP_ORIGIN, resolveEmailLinkBaseUrl } from "@/lib/app-url";

const MAX_SMS_REPLY_CHARS = 1500;

/**
 * A stored role of `unknown` (or an unrecognised value, which coerces to it) is
 * "nobody recorded one", not a role — pinning the reply to `<mgr>:unknown:<phone>`
 * would fork it off the counterparty's real thread. Undefined instead lets the
 * writers apply their own `deriveCounterpartyRole` default.
 */
function knownCounterpartyRole(value: unknown): SmsCounterpartyRole | undefined {
  const role = coerceCounterpartyRole(value);
  return role === "unknown" ? undefined : role;
}

export type EmailSmsReplyResult = {
  /** False → the token no longer resolves; caller falls back to support ingest. */
  handled: boolean;
  sent: boolean;
  idempotent?: boolean;
  error?: string;
};

/**
 * Atomically claim this email id's send. Returns true only for the caller that
 * inserted the row — a webhook redelivery gets false and must not send again.
 */
async function claimEmailSmsReply(
  db: SupabaseClient,
  emailId: string,
  managerEmail: string,
  counterpartyPhone: string,
): Promise<boolean> {
  const id = `sms_email_reply_${emailId}`;
  const { data } = await db
    .from("portal_outbound_mail_records")
    .upsert(
      {
        id,
        recipient_email: managerEmail,
        subject: "SMS reply via email",
        channel: "sms",
        row_data: {
          id,
          to: counterpartyPhone,
          kind: "sms_email_reply",
          emailId,
          claimedAt: new Date().toISOString(),
        },
      },
      { onConflict: "id", ignoreDuplicates: true },
    )
    .select("id");
  return (data ?? []).length > 0;
}

/**
 * What the claiming attempt actually did, read back for a redelivery. The claim
 * proves "someone already handled this email", never "a text went out" — the
 * first attempt may have bounced on an empty body, an auth refusal, the
 * throttle, an exhausted grant, or a failed send. `smsSent` is absent while the
 * first attempt is still in flight, which reads as not-sent: the honest answer
 * for a caller asking right now.
 */
async function readClaimOutcome(
  db: SupabaseClient,
  emailId: string,
): Promise<{ smsSent: boolean; error?: string }> {
  const { data } = await db
    .from("portal_outbound_mail_records")
    .select("row_data")
    .eq("id", `sms_email_reply_${emailId}`)
    .maybeSingle()
    .then((res) => res, () => ({ data: null }));
  const rowData = (data?.row_data as Record<string, unknown> | null) ?? null;
  const error = typeof rowData?.smsError === "string" ? rowData.smsError : undefined;
  return { smsSent: rowData?.smsSent === true, ...(error ? { error } : {}) };
}

/** Best-effort outcome stamp on the claimed row so a failed leg is diagnosable. */
async function recordClaimOutcome(
  db: SupabaseClient,
  emailId: string,
  outcome: { smsSent: boolean; sid?: string | null; error?: string | null },
): Promise<void> {
  const id = `sms_email_reply_${emailId}`;
  const { data } = await db
    .from("portal_outbound_mail_records")
    .select("row_data")
    .eq("id", id)
    .maybeSingle();
  const rowData = ((data?.row_data as Record<string, unknown> | null) ?? { id });
  await db
    .from("portal_outbound_mail_records")
    .update({
      row_data: {
        ...rowData,
        smsSent: outcome.smsSent,
        smsSid: outcome.sid ?? null,
        smsError: outcome.error ?? null,
      },
    })
    .eq("id", id)
    .then(() => undefined, () => undefined);
}

/**
 * The counterparty's role + account id in this conversation, read from the
 * newest stored message in either direction, so the emailed reply threads into
 * the SAME conversation the inbound text lives in (a prospect stays a
 * prospect, a resident a resident).
 */
async function resolveConversationIdentity(
  db: SupabaseClient,
  managerUserId: string,
  counterpartyPhone: string,
): Promise<{ counterpartyRole: SmsCounterpartyRole | undefined; residentUserId: string | null }> {
  const { data: outRows } = await db
    .from("manager_sms_messages")
    .select("counterparty_role, resident_user_id, created_at")
    .eq("manager_user_id", managerUserId)
    .eq("resident_phone", counterpartyPhone)
    .order("created_at", { ascending: false })
    .limit(1);
  const out = (outRows ?? [])[0] as
    | { counterparty_role: string | null; resident_user_id: string | null }
    | undefined;
  if (out) {
    return {
      counterpartyRole: knownCounterpartyRole(out.counterparty_role),
      residentUserId: out.resident_user_id ?? null,
    };
  }
  const { data: inRows } = await db
    .from("inbound_sms_log")
    .select("counterparty_role, matched_sender_user_id, created_at")
    .eq("manager_user_id", managerUserId)
    .eq("from_phone", counterpartyPhone)
    .order("created_at", { ascending: false })
    .limit(1);
  const inbound = (inRows ?? [])[0] as
    | { counterparty_role: string | null; matched_sender_user_id: string | null }
    | undefined;
  if (inbound) {
    return {
      counterpartyRole: knownCounterpartyRole(inbound.counterparty_role),
      residentUserId: inbound.matched_sender_user_id ?? null,
    };
  }
  return { counterpartyRole: undefined, residentUserId: null };
}

/**
 * The reply text AND the message's headers, from ONE Resend round trip.
 *
 * Both consumers need the same received-email resource — the body when the
 * webhook carried metadata only, the headers for the authentication check — so
 * fetching it twice would double an 8s-timeout call inline in the webhook. The
 * body path keeps its retry/backoff; when the body was already inlined a single
 * attempt is made, purely so the auth check still has headers to read.
 */
async function resolveReplyPayload(
  parsed: ParsedInboundEmail,
): Promise<{ text: string; headers: ResendReceivedEmailHeaders | null }> {
  const inline = parsed.text?.trim()
    ? stripEmailReplyQuote(parsed.text)
    : parsed.html?.trim()
      ? stripEmailReplyQuote(htmlToText(parsed.html))
      : "";
  const fetched = inline
    ? await fetchResendReceivedEmailBody(parsed.emailId)
    : await fetchResendReceivedEmailBodyWithRetry(parsed.emailId);
  const headers = fetched.kind === "body" || fetched.kind === "empty" ? (fetched.headers ?? null) : null;
  if (inline) return { text: inline, headers };
  return { text: fetched.kind === "body" ? stripEmailReplyQuote(fetched.text) : "", headers };
}

/**
 * Did this reply really come from the manager? The `sms+` token verifies
 * against the `From` header, which is spoofable, so the receiving MTA's
 * `Authentication-Results` is consulted — under the rules in
 * `email-authentication.ts`, where a forged in-message header can refuse a
 * send but can never authorize one.
 */
function assessAuth(
  parsed: ParsedInboundEmail,
  headers: ResendReceivedEmailHeaders | null,
): InboundEmailAuthOutcome {
  return assessInboundEmailAuthentication(headers?.["authentication-results"], parsed.fromEmail);
}

const GRANT_BOUNCE_REASON =
  "PropLane allows one emailed reply per notification email, for up to 7 days, and this conversation has none left. Open PropLane to reply.";

/**
 * Tell the manager their emailed reply did not go out.
 *
 * Throttled HERE, at the one place bounces are sent, so no refusal branch can
 * forget: a bounce is mail PropLane sends on the strength of a spoofable
 * `From`, and an attacker holding a leaked `sms+` address gets a fresh claim
 * per Resend email id, so an unthrottled refusal path is an inbox-flood vector.
 * Its bucket is deliberately SEPARATE from the send allowance — a forged flood
 * must not be able to spend the manager's own budget for real replies.
 *
 * ⚠️ Scope: this throttle and the send throttle both use the in-memory
 * `rateLimit`, which is PER SERVERLESS INSTANCE and resets on a cold start — so
 * the real fleet-wide ceiling is this number times the number of live instances.
 * Best-effort, not a guarantee. Sends stay bounded regardless by the DB-backed
 * grant counter (`consumeSmsEmailReplyGrant`), which is the actual limit on
 * texts; only the bounce ceiling is soft. A durable, DB-backed throttle is a
 * separate follow-up and is deliberately NOT built here.
 */
async function bounceToManager(args: {
  managerUserId: string;
  managerEmail: string;
  counterpartyPhone: string;
  reason: string;
}): Promise<void> {
  const throttle = rateLimit(
    smsEmailReplyBounceRateLimitKey(args.managerUserId, args.counterpartyPhone),
    3,
    3_600_000,
  );
  if (!throttle.ok) return;
  await sendManagerNoticeEmail({
    toEmail: args.managerEmail,
    subject: "Your text reply could not be sent",
    text: [
      `PropLane could not deliver your emailed reply as a text to ${args.counterpartyPhone}.`,
      "",
      `Reason: ${args.reason}`,
      "",
      "Open PropLane → Communication to send it from the portal instead.",
    ].join("\n"),
  }).catch(() => ({ sent: false }));
}

/**
 * Route a verified `sms+` reply into its SMS conversation and send it onward.
 * Ack-200 semantics: every outcome except "token owner missing" is handled
 * here (including failures, which bounce back to the manager) — a 5xx would
 * make Resend retry a send that is deliberately claimed-once.
 */
export async function ingestInboundEmailSmsReply(
  parsed: ParsedInboundEmail,
  target: { managerUserId: string; counterpartyPhone: string },
  db: SupabaseClient = createSupabaseServiceRoleClient(),
): Promise<EmailSmsReplyResult> {
  const { data: profile } = await db
    .from("profiles")
    .select("email")
    .eq("id", target.managerUserId)
    .maybeSingle();
  const managerEmail = String(profile?.email ?? "").trim().toLowerCase();
  // The MAC bound the manager's email at notification time; if the account is
  // gone or the address changed since, fall through to the support inbox
  // rather than trusting a stale binding.
  if (!managerEmail || managerEmail !== parsed.fromEmail.trim().toLowerCase()) {
    return { handled: false, sent: false };
  }

  const claimed = await claimEmailSmsReply(
    db,
    parsed.emailId,
    managerEmail,
    target.counterpartyPhone,
  );
  if (!claimed) {
    const prior = await readClaimOutcome(db, parsed.emailId);
    return { handled: true, sent: prior.smsSent, idempotent: true, ...(prior.error ? { error: prior.error } : {}) };
  }

  // Past the claim, a redelivery no-ops — so an unexpected throw here would lose
  // the manager's reply with zero signal. Every exit below reports back.
  try {
    return await deliverClaimedEmailSmsReply(db, parsed, target, managerEmail);
  } catch (e) {
    console.error(
      "inbound email sms reply failed after claim",
      parsed.emailId,
      e instanceof Error ? e.message : e,
    );
    await recordClaimOutcome(db, parsed.emailId, {
      smsSent: false,
      error: "ingest_error",
    }).catch(() => undefined);
    await bounceToManager({
      managerUserId: target.managerUserId,
      managerEmail,
      counterpartyPhone: target.counterpartyPhone,
      reason: "The text could not be sent from your PropLane number.",
    }).catch(() => undefined);
    return { handled: true, sent: false, error: "ingest_error" };
  }
}

async function deliverClaimedEmailSmsReply(
  db: SupabaseClient,
  parsed: ParsedInboundEmail,
  target: { managerUserId: string; counterpartyPhone: string },
  managerEmail: string,
): Promise<EmailSmsReplyResult> {
  const payload = await resolveReplyPayload(parsed);
  const text = payload.text.trim().slice(0, MAX_SMS_REPLY_CHARS);
  if (!text) {
    await recordClaimOutcome(db, parsed.emailId, { smsSent: false, error: "empty_body" });
    await bounceToManager({
      managerUserId: target.managerUserId,
      managerEmail,
      counterpartyPhone: target.counterpartyPhone,
      reason: "The reply body could not be read from the email.",
    });
    return { handled: true, sent: false, error: "empty_body" };
  }

  const auth = assessAuth(parsed, payload.headers);
  // ONLY an explicit aligned failure refuses outright. Everything else —
  // including a verdict we cannot attribute to a pinned receiver, which is the
  // default state — falls through to the grant below, because the grant is the
  // gate. Bouncing "unauthenticated" instead would take the email-reply leg
  // offline for every deployment that has not pinned an authserv-id.
  if (auth === "reject") {
    await recordClaimOutcome(db, parsed.emailId, { smsSent: false, error: "auth_failed" });
    await bounceToManager({
      managerUserId: target.managerUserId,
      managerEmail,
      counterpartyPhone: target.counterpartyPhone,
      reason:
        "A reply claiming to be you failed sender authentication, so PropLane did not text it. If you did send it, reply from PropLane instead.",
    });
    return { handled: true, sent: false, error: "auth_failed" };
  }

  // Only a reply that has cleared authentication reaches the manager's own send
  // budget, so a forged flood — which stops above — can never exhaust it and
  // silence them. Still checked BEFORE the grant, so a throttled reply does not
  // also burn the allowance it never got to use.
  if (!rateLimit(smsEmailReplyRateLimitKey(target.managerUserId, target.counterpartyPhone), 3, 3_600_000).ok) {
    await recordClaimOutcome(db, parsed.emailId, { smsSent: false, error: "rate_limited" });
    await bounceToManager({
      managerUserId: target.managerUserId,
      managerEmail,
      counterpartyPhone: target.counterpartyPhone,
      reason: "Too many emailed replies to this conversation in the last hour.",
    });
    return { handled: true, sent: false, error: "rate_limited" };
  }

  // The grant is consumed LAST, so a reply refused by any gate above it still
  // leaves the manager's reply allowance intact.
  if (auth !== "authenticated") {
    const grant = await consumeSmsEmailReplyGrant(db, {
      managerUserId: target.managerUserId,
      counterpartyPhone: target.counterpartyPhone,
    });
    if (!grant.ok) {
      await recordClaimOutcome(db, parsed.emailId, {
        smsSent: false,
        error: `grant_${grant.reason}`,
      });
      await bounceToManager({
        managerUserId: target.managerUserId,
        managerEmail,
        counterpartyPhone: target.counterpartyPhone,
        reason: GRANT_BOUNCE_REASON,
      });
      return { handled: true, sent: false, error: `grant_${grant.reason}` };
    }
  }

  const identity = await resolveConversationIdentity(
    db,
    target.managerUserId,
    target.counterpartyPhone,
  );

  const send = await sendFromManagerWorkNumber({
    managerUserId: target.managerUserId,
    to: target.counterpartyPhone,
    text,
    residentUserId: identity.residentUserId,
    source: "work_number",
    counterpartyRole: identity.counterpartyRole,
    // Logged explicitly below with the delivery sid — skipLog avoids a double
    // conversation row from the transport's own logger.
    skipLog: true,
  });

  if (!send.ok) {
    await recordClaimOutcome(db, parsed.emailId, {
      smsSent: false,
      error: send.error ?? "send_failed",
    });
    await bounceToManager({
      managerUserId: target.managerUserId,
      managerEmail,
      counterpartyPhone: target.counterpartyPhone,
      reason:
        send.error === "recipient_opted_out"
          ? "That number has opted out of texts (they replied STOP)."
          : "The text could not be sent from your PropLane number.",
    });
    return { handled: true, sent: false, error: send.error ?? "send_failed" };
  }

  await logManagerSmsMessage(db, {
    managerUserId: target.managerUserId,
    residentPhone: target.counterpartyPhone,
    residentUserId: identity.residentUserId,
    direction: "outbound",
    body: text,
    toPhone: target.counterpartyPhone,
    messageSid: send.sid ?? `email_${parsed.emailId}`,
    source: "email_reply",
    counterpartyRole: identity.counterpartyRole,
  }).catch(() => false);
  await recordClaimOutcome(db, parsed.emailId, { smsSent: true, sid: send.sid ?? null });

  return { handled: true, sent: true };
}

/**
 * A co-manager (or any viewer) replied to a portal-only `smsp+` notification.
 * Never send SMS — bounce with the same portal-only explanation so the reply
 * is never silently discarded into support ingest.
 */
export async function ingestInboundEmailSmsPortalOnlyReply(
  parsed: ParsedInboundEmail,
  target: { managerUserId: string; counterpartyPhone: string },
  db: SupabaseClient = createSupabaseServiceRoleClient(),
): Promise<EmailSmsReplyResult> {
  const { data: profile } = await db
    .from("profiles")
    .select("email")
    .eq("id", target.managerUserId)
    .maybeSingle();
  const managerEmail = String(profile?.email ?? "").trim().toLowerCase();
  if (!managerEmail || managerEmail !== parsed.fromEmail.trim().toLowerCase()) {
    return { handled: false, sent: false };
  }

  const claimed = await claimEmailSmsReply(
    db,
    parsed.emailId,
    managerEmail,
    target.counterpartyPhone,
  );
  if (!claimed) {
    return { handled: true, sent: false, idempotent: true, error: "portal_only_reply" };
  }

  await recordClaimOutcome(db, parsed.emailId, {
    smsSent: false,
    error: "portal_only_reply",
  }).catch(() => undefined);

  const portalLink = `${(resolveEmailLinkBaseUrl() || PRODUCTION_APP_ORIGIN).replace(/\/$/, "")}/portal/communication`;
  const throttle = rateLimit(
    smsEmailReplyBounceRateLimitKey(target.managerUserId, target.counterpartyPhone),
    3,
    3_600_000,
  );
  if (throttle.ok) {
    await sendManagerNoticeEmail({
      toEmail: managerEmail,
      subject: "Reply by email will not reach the renter",
      text: [CO_MANAGER_SMS_EMAIL_PORTAL_ONLY_COPY, "", portalLink].join("\n"),
    }).catch(() => ({ sent: false }));
  }

  return { handled: true, sent: false, error: "portal_only_reply" };
}
