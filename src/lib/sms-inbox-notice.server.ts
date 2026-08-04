/**
 * Shared delivery helpers for SMS-originated manager notices, used by both
 * inbound-SMS paths (work-number → Axis inbox, and the proxy-pair relay
 * mirror) so the two never drift.
 *
 * Direct thread-row write (the notifyManagerFromAgent pattern) because
 * deliverPortalInboxMessage drops recipients whose email equals the sender's —
 * a self-addressed notice would silently deliver to no one.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { PRODUCTION_APP_ORIGIN, resolveEmailLinkBaseUrl } from "@/lib/app-url";
import {
  buildSmsPortalOnlyReplyAddress,
  buildSmsReplyAddress,
  smsConversationAnchorMessageId,
} from "@/lib/inbound-email/reply-address.server";
import { grantSmsEmailReply } from "@/lib/inbound-email/sms-reply-grant.server";
import { formatPacificDateTime } from "@/lib/pacific-time";
import { isPortalSandboxEmail } from "@/lib/portal-sandbox-accounts";

const MANAGER_INBOX_SCOPE = "axis_portal_inbox_manager_v1";

/** Plain copy for co-manager notification emails + portal-only bounce replies. */
export const CO_MANAGER_SMS_EMAIL_PORTAL_ONLY_COPY =
  "Replying to this email will NOT reach the renter. Open PropLane → Communication to reply from the portal.";

export async function upsertManagerInboxNotice(
  db: SupabaseClient,
  args: {
    managerUserId: string;
    idPrefix: string;
    threadType: string;
    folder?: "inbox" | "sent";
    from: string;
    subject: string;
    preview: string;
    body: string;
    unread?: boolean;
  },
): Promise<void> {
  const threadId = `${args.idPrefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  await db
    .from("portal_inbox_thread_records")
    .upsert(
      {
        id: threadId,
        scope: MANAGER_INBOX_SCOPE,
        owner_user_id: args.managerUserId,
        participant_email: null,
        thread_type: args.threadType,
        row_data: {
          id: threadId,
          folder: args.folder ?? "inbox",
          from: args.from,
          email: "",
          subject: args.subject,
          preview: args.preview.slice(0, 100).replace(/\n/g, " "),
          body: args.body,
          time: formatPacificDateTime(new Date()),
          unread: args.unread ?? true,
          scope: MANAGER_INBOX_SCOPE,
        },
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" },
    )
    .then(
      () => undefined,
      () => undefined,
    );
}

export async function sendManagerNoticeEmail(args: {
  toEmail: string | null | undefined;
  subject: string;
  text: string;
  /** Signed reply address so an emailed reply routes back into the conversation. */
  replyTo?: string | null;
  /** Extra headers (threading anchors). */
  headers?: Record<string, string>;
}): Promise<{ sent: boolean }> {
  const managerEmail = String(args.toEmail ?? "").trim().toLowerCase();
  const resendKey = process.env.RESEND_API_KEY?.trim();
  if (!resendKey || !managerEmail.includes("@") || isPortalSandboxEmail(managerEmail)) {
    return { sent: false };
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.RESEND_FROM?.trim() || "PropLane <onboarding@resend.dev>",
      to: [managerEmail],
      subject: args.subject,
      text: args.text,
      ...(args.replyTo ? { reply_to: args.replyTo } : {}),
      ...(args.headers ? { headers: args.headers } : {}),
    }),
  }).catch(() => null);
  return { sent: Boolean(res?.ok) };
}

/** Domain of the configured From address — SMS threading anchors live under it. */
function noticeFromDomain(): string {
  const from = process.env.RESEND_FROM?.trim() || "PropLane <onboarding@resend.dev>";
  const email = from.match(/<([^>]+)>/)?.[1] ?? from;
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1).trim().toLowerCase() : "prop-lane.space";
}

export type InboundSmsManagerNotification = {
  managerUserId: string;
  /** Counterparty (texter) phone, E.164 preferred. */
  fromPhone: string;
  /** The inbound text body. */
  text: string;
  /** What PropLane auto-replied, when anything did. */
  autoReply?: string | null;
  /** "Tour request", "Resident text", … — defaults to "New text". */
  subjectLabel?: string;
  propertyLabel?: string | null;
  /** Display name for the texter when known; defaults to a masked handle. */
  senderLabel?: string | null;
  /** Inbox notice row id prefix + thread type (kept per caller for continuity). */
  idPrefix?: string;
  threadType?: string;
  /** Skip the inbox notice (caller already wrote its own representation). */
  skipInboxNotice?: boolean;
  /**
   * Owner of the work number that was texted gets a sendable `sms+` Reply-To.
   * Co-managers (and any other viewer copy) must pass `false`: they get a
   * portal-only `smsp+` address that bounces with an explanation, never a
   * sendable token that would text from the wrong number. Default `true` for
   * owner-only call sites.
   */
  includeSmsReplyToken?: boolean;
};

/**
 * The ONE inbound-SMS → manager notification fan-out shared by every inbound
 * path: writes the manager inbox notice AND emails a copy. The property OWNER's
 * copy carries a signed `sms+` Reply-To so answering the email texts the
 * sender back from the work number; co-manager copies (`includeSmsReplyToken:
 * false`) get a portal-only `smsp+` Reply-To and explicit "replying by email
 * will not reach the renter" copy — never a sendable token.
 *
 * The email leg is best-effort and never blocks the inbox write; sandbox
 * addresses are skipped inside `sendManagerNoticeEmail`.
 */
export async function notifyManagerOfInboundSms(
  db: SupabaseClient,
  args: InboundSmsManagerNotification,
): Promise<{ inboxNoticeWritten: boolean; emailSent: boolean }> {
  const managerUserId = args.managerUserId.trim();
  const fromPhone = String(args.fromPhone ?? "").trim();
  if (!managerUserId || !fromPhone) return { inboxNoticeWritten: false, emailSent: false };

  const includeSmsReplyToken = args.includeSmsReplyToken !== false;
  const subjectLabel = args.subjectLabel?.trim() || "New text";
  const where = args.propertyLabel?.trim() ? ` — ${args.propertyLabel.trim()}` : "";
  const sender = args.senderLabel?.trim() || fromPhone;
  const subject = `(${subjectLabel}${where}) ${sender}`;
  const bodyLines = [
    subject,
    "",
    args.text || "(empty message)",
    ...(args.autoReply?.trim() ? ["", "— PropLane replied —", args.autoReply.trim()] : []),
  ];

  let inboxNoticeWritten = false;
  if (!args.skipInboxNotice) {
    await upsertManagerInboxNotice(db, {
      managerUserId,
      idPrefix: args.idPrefix ?? "sms_inbound",
      threadType: args.threadType ?? "claw_resident_sms",
      from: fromPhone,
      subject,
      preview: (args.text || "(empty)").slice(0, 140),
      body: bodyLines.join("\n"),
      unread: true,
    });
    inboxNoticeWritten = true;
  }

  const { data: profile } = await db
    .from("profiles")
    .select("email")
    .eq("id", managerUserId)
    .maybeSingle();
  const managerEmail = String(profile?.email ?? "").trim().toLowerCase();
  if (!managerEmail.includes("@")) return { inboxNoticeWritten, emailSent: false };

  const portalLink = `${(resolveEmailLinkBaseUrl() || PRODUCTION_APP_ORIGIN).replace(/\/$/, "")}/portal/communication`;
  // Owner: sendable sms+ token. Co-manager: smsp+ portal-only (bounce, never send).
  const replyTo = includeSmsReplyToken
    ? buildSmsReplyAddress(managerUserId, managerEmail, fromPhone)
    : buildSmsPortalOnlyReplyAddress(managerUserId, managerEmail, fromPhone);
  // Threading anchors for the OWNER conversation identity (the number that was
  // texted), not the co-manager's id — mail clients still group by the work
  // number's counterparty when the caller passes the owner's id as managerUserId
  // for owner copies. Co-manager copies intentionally use the co-manager's id
  // so their mailbox groups their own notification stream separately.
  const anchor = smsConversationAnchorMessageId(managerUserId, fromPhone, noticeFromDomain());
  const emailText = includeSmsReplyToken
    ? [
        `${sender} texted your PropLane number:`,
        "",
        args.text || "(empty message)",
        ...(args.autoReply?.trim() ? ["", "PropLane auto-replied:", args.autoReply.trim()] : []),
        "",
        replyTo
          ? "Reply to this email to text them back from your PropLane number."
          : "Open PropLane to reply from your PropLane number.",
        portalLink,
      ].join("\n")
    : [
        `${sender} texted the property's PropLane number:`,
        "",
        args.text || "(empty message)",
        ...(args.autoReply?.trim() ? ["", "PropLane auto-replied:", args.autoReply.trim()] : []),
        "",
        CO_MANAGER_SMS_EMAIL_PORTAL_ONLY_COPY,
        portalLink,
      ].join("\n");

  const { sent } = await sendManagerNoticeEmail({
    toEmail: managerEmail,
    subject,
    text: emailText,
    replyTo,
    headers: { "In-Reply-To": anchor, References: anchor },
  });
  // Only a sendable owner token opens a reply grant. Co-manager smsp+ addresses
  // bounce; they must never bank an allowance that could authorize a send.
  if (sent && includeSmsReplyToken && replyTo) {
    const banked = await grantSmsEmailReply(db, {
      managerUserId,
      counterpartyPhone: fromPhone,
      managerEmail,
    }).catch((e) => {
      console.error("sms reply grant threw", managerUserId, e instanceof Error ? e.message : e);
      return false;
    });
    if (!banked) console.error("sms reply grant not banked after notification", managerUserId);
  }
  return { inboxNoticeWritten, emailSent: sent };
}
