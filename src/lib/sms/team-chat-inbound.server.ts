import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  postTeamThreadMessage,
  relayTeamChatMessageToSms,
  resolveWorkspaceTeamMembers,
  teamMemberCanPost,
} from "@/lib/team-comms.server";
import { startsWithAssistantAddress, stripAssistantAddress } from "@/lib/sms/team-chat-routing";
import { classifySmsConfirmationReply, resolveOpenSmsProposal } from "@/lib/sms/agent-confirmation.server";
import { readPortalAssistantSmsSession } from "@/lib/agent/portal-assistant-session.server";

export type ManagerInboundRoute =
  /** Goes to the PropLane Assistant (an explicit address, a solo workspace, or a sender who cannot post to the chat). */
  | { kind: "agent"; text: string }
  /** Appended to the workspace Team chat and relayed; nothing else to do. */
  | { kind: "team"; ok: true }
  /** The chat append failed; the caller retries the whole inbound. */
  | { kind: "team"; ok: false };

/**
 * Is this text the answer to a write the Assistant asked this member to confirm?
 *
 * The Assistant ends a proposal with "Reply YES to confirm or NO to cancel", and a confirmation is
 * an authorization, not conversation: routed to the Team chat it would claim nothing, leave the
 * pending action unanswered, and broadcast a private authorization to every teammate. The reply
 * only wins when there really is an open proposal on this member's own Assistant session, so a
 * teammate agreeing with a plan ("yes") still reaches the chat.
 *
 * Fails CLOSED to the Team chat: an unreadable session or proposal read is not evidence of an open
 * proposal, and the agent turn re-reads it anyway.
 */
async function answersOpenAssistantProposal(
  db: SupabaseClient,
  input: { actorUserId: string; workspaceId: string | null; body: string },
): Promise<boolean> {
  if (classifySmsConfirmationReply(input.body) === "none") return false;
  const found = await readPortalAssistantSmsSession(db, {
    actorUserId: input.actorUserId,
    workspaceId: input.workspaceId,
  });
  if (!found.ok || !found.session) return false;
  const open = await resolveOpenSmsProposal(db, {
    userId: input.actorUserId,
    sessionId: found.session.id,
    portal: "manager",
  });
  return open.status === "one" || open.status === "ambiguous";
}

/**
 * Decide and carry out the route for a text from an identified manager
 * (`resolveManagerSmsInboundIdentity` already proved exactly one verified
 * match for this work number's owner; STOP/HELP were handled before this).
 *
 *  - "@assistant ..." / "assistant, ..." / "@ai ..." -> the Assistant, prefix stripped.
 *  - a workspace with fewer than two members       -> the Assistant (today's behavior).
 *  - a sender who is not a member of THIS number's workspace, or a Viewer -> the Assistant.
 *  - a bare YES/NO answering a write the Assistant asked them to confirm -> the Assistant.
 *  - otherwise -> the workspace Team chat as that member (channel sms, idempotent on the
 *    MessageSid) and relayed to every OTHER member, never back to the sender.
 *
 * Never logs a phone or a body.
 */
export async function routeManagerInboundText(
  db: SupabaseClient,
  input: {
    ownerManagerUserId: string;
    /** The work number's workspace (null = the owner's default). */
    workspaceId: string | null;
    actorUserId: string;
    body: string;
    messageSid: string;
  },
): Promise<ManagerInboundRoute> {
  if (startsWithAssistantAddress(input.body)) return { kind: "agent", text: stripAssistantAddress(input.body) };

  const members = await resolveWorkspaceTeamMembers(db, {
    ownerManagerUserId: input.ownerManagerUserId,
    workspaceId: input.workspaceId,
  });
  const sender = members.find((member) => member.userId === input.actorUserId);
  if (members.length < 2 || !sender || !teamMemberCanPost(sender)) {
    return { kind: "agent", text: input.body };
  }

  const confirming = await answersOpenAssistantProposal(db, {
    actorUserId: input.actorUserId,
    workspaceId: input.workspaceId,
    body: input.body,
  }).catch(() => false);
  if (confirming) return { kind: "agent", text: input.body };

  const { data: profile } = await db.from("profiles").select("full_name").eq("id", input.actorUserId).maybeSingle();
  const senderName = String((profile as { full_name?: unknown } | null)?.full_name ?? "").trim() || "A teammate";
  const text = input.body.trim();
  const messageId = `team-sms:${input.messageSid}`;
  const posted = await postTeamThreadMessage(db, {
    ownerManagerUserId: input.ownerManagerUserId,
    workspaceId: input.workspaceId,
    actorUserId: input.actorUserId,
    actorName: senderName,
    text,
    messageId,
    channel: "sms",
  });
  if (!posted.ok) return { kind: "team", ok: false };
  // Always relay: the dedupe key (message, member) makes a replay or a retry
  // after a crash between the post and the texts send each text exactly once.
  const relayed = await relayTeamChatMessageToSms(db, {
    ownerManagerUserId: input.ownerManagerUserId,
    workspaceId: posted.workspaceId,
    senderUserId: input.actorUserId,
    senderName,
    text,
    messageId,
  }).catch((error: unknown) => {
    console.error("team-chat inbound relay failed", error instanceof Error ? error.name : "unknown");
    return [] as Awaited<ReturnType<typeof relayTeamChatMessageToSms>>;
  });
  // A member the relay could not text is reported, never swallowed: the chat itself succeeded, so
  // the inbound stays completed (a terminal reason — no credit, a paused line — would otherwise
  // retry this text forever), but the reasons must be visible. Never logs a phone or a body.
  const undelivered = relayed.filter((outcome) => outcome.status === "failed");
  if (undelivered.length > 0) {
    console.error(
      "team-chat inbound relay undelivered",
      JSON.stringify({ count: undelivered.length, reasons: [...new Set(undelivered.map((o) => o.reason ?? "unknown"))] }),
    );
  }
  return { kind: "team", ok: true };
}
