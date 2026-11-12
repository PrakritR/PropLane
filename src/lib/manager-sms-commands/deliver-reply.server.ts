import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isPropLaneFallbackRefusalCode } from "@/lib/prospect-spine/payer.server";

type DeliverArgs = {
  managerUserId: string;
  actorUserId: string;
  toPhone: string;
  text: string;
  workNumber?: string | null;
  inboundMessageSid: string;
  workspaceId?: string | null;
};
type SendOutcome = { ok: boolean; durablyAccepted?: boolean; error?: string };

export type CommandReplyDeps = {
  deliver: (args: DeliverArgs) => Promise<SendOutcome>;
  fallback: (db: SupabaseClient, input: { ownerUserId: string; workspaceId: string | null; to: string; body: string; claimKey: string; refusalCode: string | null }) => Promise<{ attempted: boolean; ok: boolean; reason?: string }>;
  notify: (db: SupabaseClient, input: { landlordId: string; senderOwnerId: string | null; subject: string; text: string; idempotencyKey: string; workspaceId: string | null }) => Promise<unknown>;
};

function refusalText(code: string | null | undefined): string {
  const c = (code ?? "").trim();
  if (c.startsWith("comms_billing_") || c === "credit_unavailable") return "the workspace's text credit is used up";
  if (c === "quiet_hours") return "texts are paused during quiet hours";
  if (c === "recipient_opted_out") return "your number has opted out of texts";
  return "the text line refused it";
}

/**
 * The answer to a manager's text command (a price change, a new listing, a handle reply) goes back to their own phone. It must
 * never vanish: a refused send on a PropLane-MANAGED workspace is re-sent by PropLane on the shared line (the client's empty
 * wallet is not the reason a manager hears nothing), and an answer that still cannot be texted lands in the manager's Assistant
 * thread with the reason and the answer itself. Never throws.
 */
export async function deliverManagerCommandReply(
  db: SupabaseClient,
  args: DeliverArgs,
  deps?: Partial<CommandReplyDeps>,
): Promise<{ delivered: boolean; via: "line" | "proplane" | "assistant" | "none" }> {
  const resolved: CommandReplyDeps = {
    deliver: deps?.deliver ?? (async (a) => (await import("@/lib/agent/manager-sms-agent.server")).deliverManagerSmsReply({ ...a })),
    fallback: deps?.fallback ?? (async (d, i) => (await import("@/lib/prospect-spine/payer.server")).sendAsPropLaneAfterRefusal(d, i)),
    notify: deps?.notify ?? (async (d, i) => (await import("@/lib/agent-notify.server")).notifyManagerFromAgent(d, {
      landlordId: i.landlordId,
      subject: i.subject,
      text: i.text,
      category: "messages",
      notify: { push: true, sms: false },
      idempotencyKey: i.idempotencyKey,
      ...(i.workspaceId ? { workspaceId: i.workspaceId } : {}),
      ...(i.senderOwnerId ? { senderOwnerId: i.senderOwnerId } : {}),
    })),
  };
  let refusal: string | null = null;
  try {
    const sent = await resolved.deliver(args);
    if (sent.ok || sent.durablyAccepted) return { delivered: true, via: "line" };
    refusal = sent.error ?? null;
  } catch {
    refusal = "provider_error";
  }
  try {
    if (args.workspaceId && isPropLaneFallbackRefusalCode(refusal)) {
      const fallback = await resolved.fallback(db, {
        ownerUserId: args.managerUserId, workspaceId: args.workspaceId, to: args.toPhone, body: args.text,
        claimKey: `manager-command:${args.inboundMessageSid}`, refusalCode: refusal,
      });
      if (fallback.attempted && fallback.ok) return { delivered: true, via: "proplane" };
    }
  } catch {
    /* fall through to the visible notice */
  }
  try {
    await resolved.notify(db, {
      landlordId: args.actorUserId,
      senderOwnerId: args.managerUserId !== args.actorUserId ? args.managerUserId : null,
      subject: "Your text command could not be answered by text",
      text: `I read your text, but my reply could not be texted back (${refusalText(refusal)}). My answer: ${args.text}`,
      idempotencyKey: `manager-command-reply:${args.inboundMessageSid}`,
      workspaceId: args.workspaceId ?? null,
    });
    return { delivered: true, via: "assistant" };
  } catch {
    console.error("manager command reply not delivered");
    return { delivered: false, via: "none" };
  }
}
