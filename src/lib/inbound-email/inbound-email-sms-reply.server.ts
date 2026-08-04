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
  fetchResendReceivedEmailBodyWithRetry,
  htmlToText,
  type ParsedInboundEmail,
} from "@/lib/inbound-email/inbound-email.server";
import { stripEmailReplyQuote } from "@/lib/inbound-email/inbound-email-reply.server";
import { logManagerSmsMessage } from "@/lib/manager-sms-messages.server";
import { sendFromManagerWorkNumber } from "@/lib/proplane-sms-transport.server";
import { sendManagerNoticeEmail } from "@/lib/sms-inbox-notice.server";
import {
  coerceCounterpartyRole,
  type SmsCounterpartyRole,
} from "@/lib/sms-conversation-identity";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

const MAX_SMS_REPLY_CHARS = 1500;

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
      counterpartyRole: coerceCounterpartyRole(out.counterparty_role) ?? undefined,
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
      counterpartyRole: coerceCounterpartyRole(inbound.counterparty_role) ?? undefined,
      residentUserId: inbound.matched_sender_user_id ?? null,
    };
  }
  return { counterpartyRole: undefined, residentUserId: null };
}

/** Reply text: inline body first, else the Resend received-email API. */
async function resolveReplyText(parsed: ParsedInboundEmail): Promise<string> {
  if (parsed.text?.trim()) return stripEmailReplyQuote(parsed.text);
  if (parsed.html?.trim()) return stripEmailReplyQuote(htmlToText(parsed.html));
  const fetched = await fetchResendReceivedEmailBodyWithRetry(parsed.emailId);
  if (fetched.kind === "body") return stripEmailReplyQuote(fetched.text);
  return "";
}

async function bounceToManager(args: {
  managerEmail: string;
  counterpartyPhone: string;
  reason: string;
}): Promise<void> {
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
  if (!claimed) return { handled: true, sent: true, idempotent: true };

  const text = (await resolveReplyText(parsed)).trim().slice(0, MAX_SMS_REPLY_CHARS);
  if (!text) {
    await recordClaimOutcome(db, parsed.emailId, { smsSent: false, error: "empty_body" });
    await bounceToManager({
      managerEmail,
      counterpartyPhone: target.counterpartyPhone,
      reason: "The reply body could not be read from the email.",
    });
    return { handled: true, sent: false, error: "empty_body" };
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
    source: "work_number",
    counterpartyRole: identity.counterpartyRole,
  }).catch(() => false);
  await recordClaimOutcome(db, parsed.emailId, { smsSent: true, sid: send.sid ?? null });

  return { handled: true, sent: true };
}
