/**
 * Manager PropLane Assistant thread in Communication — the manager talks to the
 * same agent as the floating assistant, but messages live in the inbox thread.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { runAgentTurn } from "@/lib/agent/loop";
import { MANAGER_SYSTEM_PROMPT } from "@/lib/agent/system-prompts";
import { PROMPT_IDS, resolvePromptMeta } from "@/lib/agent/prompt-metadata";
import { traceAgentTurn } from "@/lib/observability/langfuse";
import { agentRegistry } from "@/lib/tools";
import type { AgentContext } from "@/lib/tools/context";
import { isAdminUser } from "@/lib/auth/admin-preview";
import {
  commitInboxThreadReply,
  type InboxThreadReplyTarget,
} from "@/lib/portal-inbox-delivery";
import { MANAGER_AGENT_NOTICE_FROM_NAME } from "@/lib/communication-assistant-inbox-list";
import { MAX_HISTORY_MESSAGES } from "@/lib/agent/inbox-auto-respond.server";

async function resolveManagerInboxAgentContext(
  db: SupabaseClient,
  managerUserId: string,
): Promise<AgentContext | null> {
  const [{ data: profile }, { data: roleRows }, isAdmin] = await Promise.all([
    db.from("profiles").select("email, role").eq("id", managerUserId).maybeSingle(),
    db.from("profile_roles").select("role").eq("user_id", managerUserId),
    isAdminUser(managerUserId),
  ]);
  const roleList = (roleRows ?? []).map((r) => String(r.role).toLowerCase());
  const legacyRole = String(profile?.role ?? "").toLowerCase();
  const roles = roleList.length > 0 ? roleList : legacyRole ? [legacyRole] : [];
  const isManagerOrOwner = roles.some((r) => r === "manager" || r === "owner");
  if (!isAdmin && !isManagerOrOwner) return null;
  return {
    landlordId: managerUserId,
    userId: managerUserId,
    email: (profile?.email ?? "").trim().toLowerCase(),
    roles,
    isAdmin,
    db,
  };
}

function managerThreadTurnMessages(
  rowData: Record<string, unknown> | null | undefined,
  incoming: string,
): { role: "user" | "assistant"; content: string }[] {
  const messages = Array.isArray(rowData?.messages) ? (rowData!.messages as unknown[]) : [];
  const recent = messages.slice(-MAX_HISTORY_MESSAGES);
  const turns = recent
    .map((entry) => {
      const row = (entry ?? {}) as Record<string, unknown>;
      const body = typeof row.body === "string" ? row.body : "";
      const from = typeof row.from === "string" ? row.from : "";
      if (!body.trim()) return null;
      return {
        role: from.trim() === MANAGER_AGENT_NOTICE_FROM_NAME ? ("assistant" as const) : ("user" as const),
        content: body.trim(),
      };
    })
    .filter((entry): entry is { role: "user" | "assistant"; content: string } => Boolean(entry));
  turns.push({ role: "user", content: incoming.trim() });
  return turns;
}

export async function runManagerInboxAgentTurn(
  db: SupabaseClient,
  target: InboxThreadReplyTarget,
  managerUserId: string,
  incomingText: string,
): Promise<{ replied: boolean; reason?: string }> {
  const incoming = incomingText.trim();
  if (!incoming) return { replied: false, reason: "empty_message" };

  const ctx = await resolveManagerInboxAgentContext(db, managerUserId);
  if (!ctx) return { replied: false, reason: "unauthorized" };

  const { data: row } = await db
    .from("portal_inbox_thread_records")
    .select("row_data")
    .eq("id", target.threadId)
    .maybeSingle();
  const rowData = (row?.row_data ?? null) as Record<string, unknown> | null;
  const prior = managerThreadTurnMessages(rowData, incoming);
  const history = prior.slice(0, -1);

  try {
    let traceId: string | null = null;
    const result = await traceAgentTurn(
      {
        userId: ctx.userId,
        metadata: {
          landlordId: ctx.landlordId,
          role: "manager",
          channel: "inbox",
        },
      },
      prior,
      (observer) =>
        runAgentTurn({
          ctx,
          registry: agentRegistry,
          system: MANAGER_SYSTEM_PROMPT,
          messages: prior,
          observer,
          allowWriteTools: [],
        }),
      {
        name: "manager-inbox-agent-turn",
        sessionId: target.threadId,
        promptMeta: resolvePromptMeta(PROMPT_IDS.managerAssistant, MANAGER_SYSTEM_PROMPT),
        onTraceId: (id) => {
          traceId = id;
        },
      },
    );
    void traceId;
    void history;

    const reply = result.reply.trim();
    if (!reply && !result.pendingAction) return { replied: false, reason: "empty_reply" };

    let body = reply;
    if (result.pendingAction) {
      const label = result.pendingAction.preview?.title ?? result.pendingAction.toolName;
      body = [reply, "", `Open your dashboard to approve "${label}" before anything happens.`]
        .filter(Boolean)
        .join("\n");
    }

    await commitInboxThreadReply(db, target, {
      fromName: MANAGER_AGENT_NOTICE_FROM_NAME,
      text: body,
      outbound: false,
    });
    return { replied: true };
  } catch (error) {
    console.error("manager-inbox-agent turn failed", error);
    return { replied: false, reason: "agent_turn_failed" };
  }
}
