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
  resolveAssistantMailboxByInboundAddresses,
} from "@/lib/manager-assistant-email/manager-assistant-email.server";
import { mirrorAssistantEmailConversation } from "@/lib/manager-assistant-email/mirror-assistant-email-conversation.server";
import { mirrorAssistantEmailTurnToInbox } from "@/lib/manager-assistant-email/mirror-assistant-email-to-inbox.server";
import {
  findOrCreateResidentEmailSession,
  loadResidentEmailHistory,
  recordResidentEmailInbound,
  recordResidentEmailReply,
} from "@/lib/agent/resident-email-session.server";
import { resolveWorkspaceOwnerForWorkEmail } from "@/lib/sms/manager-workspace-role.server";
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

  const mailbox0 = await resolveAssistantMailboxByInboundAddresses(db, parsed.toEmails);
  const mailboxUserId = mailbox0?.managerUserId ?? null;
  if (!mailboxUserId) return { handled: true, replied: false };

  /* One work email per WORKSPACE. The address answers for the workspace it is
     placed in — its owner's residents and listings, its Communication. A
     legacy address still held by a pure co-manager (requested before addresses
     became workspace-owned, never placed) collapses to the owner's workspace,
     the same collapse the SMS webhook does for a legacy line — BEFORE the
     sender is classified. */
  const { ownerUserId: managerUserId, workspaceId } = await resolveWorkspaceOwnerForWorkEmail(db, mailboxUserId, {
    workspaceId: mailbox0?.workspaceId ?? null,
  });

  const claim = await claimInboundEmail(db, parsed.emailId, managerUserId);
  if (claim === "duplicate") return { handled: true, replied: false, idempotent: true };

  const rawBody = parsed.text?.trim() ? parsed.text : await resolveInboundEmailBody(parsed);
  const inboundText = stripEmailReplyQuote(rawBody).trim();
  if (!inboundText) return { handled: true, replied: false };

  const sender = await classifyAssistantEmailSender(db, {
    managerUserId,
    fromEmail: parsed.fromEmail,
  });

  /* Reply from the workspace's address when it has one; a legacy co-manager
     address that collapsed to an owner without their own falls back to the
     mailbox that was actually written to, so the reply never comes from nowhere. */
  const mailbox =
    (workspaceId ? await loadManagerAssistantEmail(db, managerUserId, workspaceId) : null) ??
    (await loadManagerAssistantEmail(db, managerUserId, null)) ??
    (managerUserId !== mailboxUserId ? await loadManagerAssistantEmail(db, mailboxUserId, null) : null);
  const senderEmail = parsed.fromEmail.trim().toLowerCase();
  const senderName = parsed.fromName?.trim() || senderEmail;

  let replyText = "";
  /**
   * The mirror runs AFTER the send so it can stamp the assistant's answer with
   * the channel it actually left on: an answer that never went out (no mailbox,
   * a failed send) is still shown to the manager, but without the EMAIL tag
   * that would claim otherwise.
   */
  let mirror: (replySent: boolean) => Promise<void> = async () => {};

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
       for what they asked the assistant. THEIR thread: on a shared workspace
       address a co-manager's questions must land in the co-manager's
       Communication, not the owner's, or the owner reads a teammate's private
       exchange with the assistant. */
    const actorUserId = sender.identity.actorUserId;
    mirror = async (replySent) => {
      try {
        await mirrorAssistantEmailTurnToInbox(db, {
          managerUserId: actorUserId,
          managerDisplayName: senderName,
          inboundText,
          replyText,
          inboundEmailId: parsed.emailId,
          subject: parsed.subject,
          replySent,
        });
      } catch (cause) {
        console.error("assistant-email inbox mirror failed", cause);
      }
    };
  } else {
    if (sender.role === "resident") {
      /* Same memory the prospect branch has: the last turns of this resident's
         email thread, persisted per turn, so "and the month after?" is answered
         by a model that saw the first question. */
      const session = await findOrCreateResidentEmailSession(db, {
        landlordId: managerUserId,
        residentEmail: senderEmail,
      });
      const history = session ? await loadResidentEmailHistory(db, session.id) : [];
      if (session) {
        await recordResidentEmailInbound(db, session, {
          text: inboundText,
          inboundEmailId: parsed.emailId,
        });
      }
      const answer = await autoRespondToResidentInboxMessage(db, {
        managerUserId,
        residentEmail: senderEmail,
        incomingText: inboundText,
        history,
        sessionId: session?.id,
      });
      replyText = answer.ok ? answer.reply.trim() : "";
      if (session && answer.ok && replyText) {
        await recordResidentEmailReply(db, session, { text: replyText, traceId: answer.traceId });
      }
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
    mirror = async (replySent) => {
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
          replySent,
        });
      } catch (cause) {
        console.error("assistant-email conversation mirror failed", cause);
      }
    };
  }

  let replied = false;
  if (replyText && mailbox) {
    const send = await deliverManagerEmailReply({
      managerUserId,
      toEmail: senderEmail,
      subject: replySubject(parsed.subject),
      text: replyText,
      fromAddress: mailbox.address,
      replyTo: mailbox.address,
    });
    replied = send.ok;
  }
  await mirror(replied);
  return { handled: true, replied, role: sender.role };
}
