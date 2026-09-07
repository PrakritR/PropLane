import "server-only";

/**
 * Front door for a manager's work email address.
 *
 * Three senders reach this address and they must not get the same answer. See
 * `classifyAssistantEmailSender` for the ordering and why it is the security
 * property. The dispatch below is deliberately thin: every branch delegates to
 * the assistant that already exists for that audience, so there is one brain per
 * role rather than a fourth one grown here.
 *
 * Two rules hold across all three branches:
 *
 * 1. EVERY inbound is mirrored into the manager's Communication tab, including
 *    one nobody replied to. The address used to accept the manager alone and
 *    drop everyone else in silence — no reply, nothing in Communication, and no
 *    recovery, because the inbound id is claimed BEFORE the sender is resolved
 *    so a redelivery dedupes against a message that was never stored. A manager
 *    could not tell "nobody wrote" from "we threw it away".
 * 2. A reply is only ever sent to the address that wrote in, from the work
 *    mailbox. The agents never choose a recipient.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { autoRespondToResidentInboxMessage } from "@/lib/agent/inbox-auto-respond.server";
import { runLeasingEmailAgentTurn } from "@/lib/agent/leasing-email-agent.server";
import {
  deliverManagerEmailReply,
  runManagerEmailAgentTurn,
} from "@/lib/agent/manager-email-agent.server";
import type { ParsedInboundEmail } from "@/lib/inbound-email/inbound-email.server";
import { resolveInboundEmailBody } from "@/lib/inbound-email/inbound-email.server";
import { stripEmailReplyQuote } from "@/lib/inbound-email/inbound-email-reply.server";
import { isAssistantEmailAddress } from "@/lib/manager-assistant-email/assistant-email-address";
import { classifyAssistantEmailSender } from "@/lib/manager-assistant-email/assistant-email-sender-role.server";
import {
  loadManagerAssistantEmail,
  resolveManagerIdByAssistantInboundAddresses,
} from "@/lib/manager-assistant-email/manager-assistant-email.server";
import { mirrorAssistantEmailConversation } from "@/lib/manager-assistant-email/mirror-assistant-email-conversation.server";
import { mirrorAssistantEmailTurnToInbox } from "@/lib/manager-assistant-email/mirror-assistant-email-to-inbox.server";
import { resolveManagerSmsAgentContext } from "@/lib/tools/manager-sms-context";

export type AssistantInboundEmailResult =
  | { handled: false }
  | {
      handled: true;
      replied: boolean;
      idempotent?: boolean;
      /** Which assistant answered — surfaced for the webhook's ack and for tests. */
      role?: "manager" | "resident" | "prospect";
    };

async function claimInboundEmail(
  db: SupabaseClient,
  emailId: string,
  managerUserId: string,
): Promise<"new" | "duplicate"> {
  const { error } = await db.from("manager_assistant_email_inbound").insert({
    resend_email_id: emailId,
    manager_user_id: managerUserId,
  });
  if (!error) return "new";
  if (error.code === "23505") return "duplicate";
  throw new Error(error.message);
}

/**
 * The mailbox owner's own address — the `participant_email` on their inbox copy.
 *
 * Never throws. It is a LABEL on the thread, not part of its identity (that is
 * the owner id plus the other party's address), so a failed read must not be
 * allowed to skip the mirror and lose the message the mirror exists to show.
 */
async function loadManagerProfileEmail(db: SupabaseClient, managerUserId: string): Promise<string> {
  try {
    const { data } = await db
      .from("profiles")
      .select("email")
      .eq("id", managerUserId)
      .maybeSingle();
    return String(data?.email ?? "").trim().toLowerCase();
  } catch {
    return "";
  }
}

function replySubject(subject: string): string {
  const trimmed = subject.trim();
  if (!trimmed) return "Re: PropLane Assistant";
  if (/^re:\s/i.test(trimmed)) return trimmed;
  return `Re: ${trimmed}`;
}

/**
 * Route inbound mail to a manager's work address through the right assistant.
 * Returns `{ handled: false }` when the To address is not an assistant mailbox.
 */
export async function processManagerAssistantInboundEmail(
  db: SupabaseClient,
  parsed: ParsedInboundEmail,
): Promise<AssistantInboundEmailResult> {
  if (!isAssistantEmailAddress(parsed.toEmails)) return { handled: false };

  const managerUserId = await resolveManagerIdByAssistantInboundAddresses(db, parsed.toEmails);
  if (!managerUserId) return { handled: true, replied: false };

  const claim = await claimInboundEmail(db, parsed.emailId, managerUserId);
  if (claim === "duplicate") return { handled: true, replied: false, idempotent: true };

  const rawBody = parsed.text?.trim() ? parsed.text : await resolveInboundEmailBody(parsed);
  const inboundText = stripEmailReplyQuote(rawBody).trim();
  if (!inboundText) return { handled: true, replied: false };

  const sender = await classifyAssistantEmailSender(db, {
    managerUserId,
    fromEmail: parsed.fromEmail,
  });

  const mailbox = await loadManagerAssistantEmail(db, managerUserId);
  const senderEmail = parsed.fromEmail.trim().toLowerCase();
  const senderName = parsed.fromName?.trim() || senderEmail;

  let replyText = "";

  if (sender.role === "manager") {
    const managerIdentity = await resolveManagerSmsAgentContext(db, {
      managerUserId: sender.identity.workNumberOwnerId,
      actorUserId: sender.identity.actorUserId,
      access: sender.identity.access,
    });
    if (managerIdentity.ok) {
      const turn = await runManagerEmailAgentTurn(db, {
        ctx: managerIdentity.ctx,
        actorEmail: sender.identity.actorEmail,
        inboundText,
        inboundEmailId: parsed.emailId,
      });
      replyText = turn?.reply?.trim() ?? "";
    }
    /* The manager's own mail belongs in their assistant thread, not in a
       conversation "with themselves" — that is the one place they already look
       for what they asked the assistant. */
    try {
      await mirrorAssistantEmailTurnToInbox(db, {
        managerUserId,
        managerDisplayName: senderName,
        inboundText,
        replyText,
        inboundEmailId: parsed.emailId,
      });
    } catch (cause) {
      console.error("assistant-email inbox mirror failed", cause);
    }
  } else {
    if (sender.role === "resident") {
      const answer = await autoRespondToResidentInboxMessage(db, {
        managerUserId,
        residentEmail: senderEmail,
        incomingText: inboundText,
      });
      replyText = answer.ok ? answer.reply.trim() : "";
    } else {
      const turn = await runLeasingEmailAgentTurn(db, {
        landlordId: managerUserId,
        prospectEmail: senderEmail,
        inboundText,
        inboundEmailId: parsed.emailId,
      });
      replyText = turn?.reply?.trim() ?? "";
    }
    /* Mirrored whether or not the agent produced a reply: the manager must see
       that this person wrote in either way. */
    const managerEmail = await loadManagerProfileEmail(db, managerUserId);
    try {
      await mirrorAssistantEmailConversation(db, {
        managerUserId,
        managerEmail,
        senderEmail,
        senderName,
        subject: parsed.subject,
        inboundText,
        replyText: replyText || null,
        inboundEmailId: parsed.emailId,
      });
    } catch (cause) {
      console.error("assistant-email conversation mirror failed", cause);
    }
  }

  if (!replyText || !mailbox) return { handled: true, replied: false, role: sender.role };

  const send = await deliverManagerEmailReply({
    toEmail: senderEmail,
    subject: replySubject(parsed.subject),
    text: replyText,
    fromAddress: mailbox.address,
    replyTo: mailbox.address,
  });
  return { handled: true, replied: send.ok, role: sender.role };
}
