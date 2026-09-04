import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  deliverManagerEmailReply,
  runManagerEmailAgentTurn,
} from "@/lib/agent/manager-email-agent.server";
import type { ParsedInboundEmail } from "@/lib/inbound-email/inbound-email.server";
import { resolveInboundEmailBody } from "@/lib/inbound-email/inbound-email.server";
import { stripEmailReplyQuote } from "@/lib/inbound-email/inbound-email-reply.server";
import { isAssistantEmailAddress } from "@/lib/manager-assistant-email/assistant-email-address";
import {
  loadManagerAssistantEmail,
  resolveManagerIdByAssistantInboundAddresses,
} from "@/lib/manager-assistant-email/manager-assistant-email.server";
import { mirrorAssistantEmailTurnToInbox } from "@/lib/manager-assistant-email/mirror-assistant-email-to-inbox.server";
import { resolveManagerEmailInboundIdentity } from "@/lib/manager-assistant-email/manager-email-access.server";
import { resolveManagerSmsAgentContext } from "@/lib/tools/manager-sms-context";

export type AssistantInboundEmailResult =
  | { handled: false }
  | { handled: true; replied: boolean; idempotent?: boolean };

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

function replySubject(subject: string): string {
  const trimmed = subject.trim();
  if (!trimmed) return "Re: PropLane Assistant";
  if (/^re:\s/i.test(trimmed)) return trimmed;
  return `Re: ${trimmed}`;
}

/**
 * Route inbound mail to `assistant+<token>@…` through the manager email agent.
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

  const identity = await resolveManagerEmailInboundIdentity(db, {
    workNumberOwnerId: managerUserId,
    fromEmail: parsed.fromEmail,
  });
  if (!identity) return { handled: true, replied: false };

  const rawBody = parsed.text?.trim()
    ? parsed.text
    : await resolveInboundEmailBody(parsed);
  const inboundText = stripEmailReplyQuote(rawBody).trim();
  if (!inboundText) return { handled: true, replied: false };

  const managerIdentity = await resolveManagerSmsAgentContext(db, {
    managerUserId: identity.workNumberOwnerId,
    actorUserId: identity.actorUserId,
    access: identity.access,
  });
  if (!managerIdentity.ok) return { handled: true, replied: false };

  const turn = await runManagerEmailAgentTurn(db, {
    ctx: managerIdentity.ctx,
    actorEmail: identity.actorEmail,
    inboundText,
    inboundEmailId: parsed.emailId,
  });
  if (!turn?.reply?.trim()) return { handled: true, replied: false };

  const mailbox = await loadManagerAssistantEmail(db, managerUserId);
  if (!mailbox) return { handled: true, replied: false };

  const replyText = turn.reply.trim();
  try {
    await mirrorAssistantEmailTurnToInbox(db, {
      managerUserId,
      managerDisplayName: parsed.fromName?.trim() || identity.actorEmail,
      inboundText,
      replyText,
      inboundEmailId: parsed.emailId,
    });
  } catch (cause) {
    console.error("assistant-email inbox mirror failed", cause);
  }

  const send = await deliverManagerEmailReply({
    toEmail: identity.actorEmail,
    subject: replySubject(parsed.subject),
    text: replyText,
    fromAddress: mailbox.address,
    replyTo: mailbox.address,
  });
  return { handled: true, replied: send.ok };
}
