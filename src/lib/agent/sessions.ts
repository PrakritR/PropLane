/**
 * Conversation persistence into the (previously unwired) agent_sessions /
 * agent_messages tables, so sessions are replayable and failed/thumbs-down
 * turns can feed the eval set. A successful portal turn writes its transcript
 * before its response is returned, so a just-finished chat is immediately
 * recoverable from the server archive. Persistence remains fail-soft: a
 * logging outage must not turn a valid assistant reply into an error.
 */
import type { AgentPortal } from "@/lib/tools/pending-actions";
import { PORTAL_CHAT_SESSION_KIND } from "@/lib/agent/chat-history";
import {
  agentChatThreadTitle,
  agentChatThreadTitleFromPrompts,
  isVagueAgentChatThreadTitle,
  storeGeneratedAgentChatThreadTitle,
} from "@/lib/agent/chat-title";
import { generateAgentChatThreadTitle } from "@/lib/agent/chat-title-generate.server";

export { agentChatThreadTitle } from "@/lib/agent/chat-title";

type SessionActor = {
  userId: string;
  /** agent_sessions.landlord_id scope: manager id for manager sessions, the
   * actor's own user id for resident/vendor sessions. */
  landlordId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNTITLED_THREAD = "New conversation";

type DatabaseError = { code?: string | null; message?: string | null; details?: string | null };

function isMissingColumn(error: unknown, column: string): boolean {
  const candidate = error as DatabaseError | null;
  const detail = `${candidate?.message ?? ""} ${candidate?.details ?? ""}`.toLowerCase();
  return detail.includes(column.toLowerCase()) && (detail.includes("column") || candidate?.code === "PGRST204");
}

function reportPersistenceFailure(operation: string, error: unknown) {
  const candidate = error as DatabaseError | null;
  // Keep operational context without logging conversation text or account data.
  console.error(`[agent/sessions] ${operation} failed`, {
    code: candidate?.code ?? "unknown",
    message: candidate?.message ?? "unknown database error",
  });
}

/**
 * Reuse the supplied session when it exists AND belongs to this actor;
 * otherwise create a fresh one. Never trusts an unowned id. Returns null when
 * persistence is unavailable so portal routes can surface an honest retryable
 * error instead of answering in a conversation that cannot be reopened.
 */
export async function ensureAgentSession(
  actor: SessionActor,
  portal: AgentPortal,
  opts: { sessionId?: string | null; title?: string | null; kind?: string } = {},
): Promise<string | null> {
  try {
    const kind = opts.kind?.trim() || PORTAL_CHAT_SESSION_KIND;
    const candidate = String(opts.sessionId ?? "").trim();
    if (candidate && UUID_RE.test(candidate)) {
      const { data, error } = await actor.db
        .from("agent_sessions")
        .update({ updated_at: new Date().toISOString() })
        .eq("id", candidate)
        .eq("user_id", actor.userId)
        .eq("portal", portal)
        .eq("kind", kind)
        .select("id")
        .maybeSingle();
      if (error) {
        reportPersistenceFailure("reuse session", error);
        return null;
      }
      if (data?.id) return String(data.id);
    }
    const sessionValues = {
      landlord_id: actor.landlordId,
      user_id: actor.userId,
      portal,
      kind,
    };
    let { data: created, error } = await actor.db
      .from("agent_sessions")
      .insert({
        ...sessionValues,
        // Portal titles are generated only after a complete turn. This avoids
        // persisting a prompt echo while the response/title model is running.
        title: kind === PORTAL_CHAT_SESSION_KIND ? UNTITLED_THREAD : agentChatThreadTitle(opts.title ?? ""),
      })
      .select("id")
      .single();
    // Keep the archive usable while a deployment is waiting for the additive
    // title migration. The thread gets the safe fallback title on reads.
    if (error && isMissingColumn(error, "title")) {
      ({ data: created, error } = await actor.db
        .from("agent_sessions")
        .insert(sessionValues)
        .select("id")
        .single());
    }
    if (error) {
      reportPersistenceFailure("create session", error);
      return null;
    }
    return created?.id ? String(created.id) : null;
  } catch (error) {
    reportPersistenceFailure("create session", error);
    return null;
  }
}

/**
 * Append a completed turn before responding, keeping the archive immediately
 * consistent for a refresh, layout switch, or cross-device reopen.
 */
export async function appendAgentMessages(
  actor: SessionActor,
  portal: AgentPortal,
  sessionId: string | null,
  rows: { role: "user" | "assistant"; content: string; toolTrace?: unknown }[],
  opts: { kind?: string } = {},
): Promise<boolean> {
  if (!sessionId || rows.length === 0) return false;
  try {
    const kind = opts.kind?.trim() || PORTAL_CHAT_SESSION_KIND;
    const { error: insertError } = await actor.db.from("agent_messages").insert(
      rows.map((r) => ({
        session_id: sessionId,
        landlord_id: actor.landlordId,
        portal,
        role: r.role,
        content: r.content.slice(0, 20_000),
        tool_trace: r.toolTrace ?? null,
      })),
    );
    if (insertError) {
      reportPersistenceFailure("append messages", insertError);
      return false;
    }
    const { data: promptRows, error: promptError } = await actor.db
      .from("agent_messages")
      .select("content")
      .eq("session_id", sessionId)
      .eq("role", "user")
      .order("created_at", { ascending: true })
      .limit(3);
    const prompts = ((promptRows ?? []) as { content?: unknown }[])
      .map((row) => (typeof row.content === "string" ? row.content : ""))
      .filter(Boolean);
    const fallbackTitle = agentChatThreadTitleFromPrompts(prompts);
    const shouldGenerateTitle =
      !promptError &&
      prompts.length > 0 &&
      prompts.length <= 2 &&
      !(prompts.length === 1 && isVagueAgentChatThreadTitle(fallbackTitle));
    const title = shouldGenerateTitle
      ? storeGeneratedAgentChatThreadTitle(
          await generateAgentChatThreadTitle(prompts, {
            userId: actor.userId,
            sessionId,
            metadata: { landlordId: actor.landlordId, portal },
          }),
        )
      : null;

    let { error: updateError } = await actor.db
      .from("agent_sessions")
      .update({ updated_at: new Date().toISOString(), ...(title ? { title } : {}) })
      .eq("id", sessionId)
      .eq("user_id", actor.userId)
      .eq("portal", portal)
      .eq("kind", kind);
    // The additive title migration may not be applied yet. Keep message
    // persistence working in that window, then derive a readable label on
    // archive reads instead.
    if (updateError && isMissingColumn(updateError, "title")) {
      ({ error: updateError } = await actor.db
        .from("agent_sessions")
        .update({ updated_at: new Date().toISOString() })
        .eq("id", sessionId)
        .eq("user_id", actor.userId)
        .eq("portal", portal)
        .eq("kind", kind));
    }
    if (updateError) {
      reportPersistenceFailure("update session timestamp", updateError);
      return false;
    }
    return true;
  } catch (error) {
    reportPersistenceFailure("append messages", error);
    return false;
  }
}
