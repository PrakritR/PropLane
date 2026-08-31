import type { ActionPreview } from "@/lib/tools/registry";
import type { AgentPortal } from "@/lib/tools/pending-actions";
import { agentChatThreadTitleFromPrompts, readGeneratedAgentChatThreadTitle } from "@/lib/agent/chat-title";

export const PORTAL_CHAT_SESSION_KIND = "portal_chat";
export const MODAL_CHAT_SESSION_KIND = "modal_chat";
export const AGENT_CHAT_HISTORY_PAGE_SIZE = 30;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AgentChatHistoryActor = {
  userId: string;
  // Session persistence already uses a service-role client, whose queries must
  // be actor-scoped in every call below.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
};

export type AgentChatThreadSummary = {
  id: string;
  title: string;
  updatedAt: string;
};

export type AgentChatTranscript = {
  id: string;
  title: string;
  updatedAt: string;
  messages: { role: "user" | "assistant"; content: string }[];
  pendingAction: { id: string; preview: ActionPreview } | null;
};

export type AgentChatThreadList = {
  threads: AgentChatThreadSummary[];
  nextCursor: string | null;
  error?: string;
};

export type AgentChatThreadDeleteResult = { ok: true } | { ok: false; error?: string };

type DatabaseError = { code?: string | null; message?: string | null; details?: string | null };

function isMissingTitleColumn(error: unknown): boolean {
  const candidate = error as DatabaseError | null;
  const detail = `${candidate?.message ?? ""} ${candidate?.details ?? ""}`.toLowerCase();
  return detail.includes("title") && (detail.includes("column") || candidate?.code === "PGRST204");
}

function reportArchiveFailure(operation: string, error: unknown) {
  const candidate = error as DatabaseError | null;
  console.error(`[agent/chat-history] ${operation} failed`, {
    code: candidate?.code ?? "unknown",
    message: candidate?.message ?? "unknown database error",
  });
}

function fallbackTitle(title: unknown): string {
  const value = String(title ?? "").trim();
  return value || "New conversation";
}

function validCursor(cursor: string | null): string | null {
  if (!cursor) return null;
  return Number.isNaN(Date.parse(cursor)) ? null : cursor;
}

function validSearchQuery(search: string | null | undefined): string | null {
  const normalized = search?.trim().replace(/\s+/g, " ") ?? "";
  return normalized ? normalized.slice(0, 120) : null;
}

export function isAgentChatSessionId(value: string | null | undefined): value is string {
  return Boolean(value && UUID_RE.test(value));
}

/**
 * The session archive is intentionally limited to `portal_chat`; SMS, inbox,
 * and legacy best-effort session rows must never surface in a portal user's
 * history panel.
 */
export async function listAgentChatThreads(
  actor: AgentChatHistoryActor,
  portal: AgentPortal,
  cursor?: string | null,
  search?: string | null,
): Promise<AgentChatThreadList> {
  try {
    const searchQuery = validSearchQuery(search);
    let matchingSessionIds: string[] | null = null;
    if (searchQuery) {
      const { data: matchedRows, error: matchError } = await actor.db
        .from("agent_messages")
        .select("session_id")
        .eq("role", "user")
        .ilike("content", `%${searchQuery}%`)
        .limit(500);
      if (matchError) {
        reportArchiveFailure("search conversations", matchError);
        return { threads: [], nextCursor: null, error: "Could not search conversations. Try again." };
      }
      matchingSessionIds = [...new Set(((matchedRows ?? []) as { session_id?: unknown }[])
        .map((row) => (typeof row.session_id === "string" ? row.session_id : ""))
        .filter(Boolean))];
      if (matchingSessionIds.length === 0) return { threads: [], nextCursor: null };
    }
    // Empty sessions still occupy `agent_sessions` rows (failed first turns,
    // leftover eager New-chat threads). Keep scanning until this response has
    // a full visible page, so orphans cannot hide older real conversations
    // behind a cursor the client never auto-advances.
    const visible: AgentChatThreadSummary[] = [];
    let scanCursor = validCursor(cursor ?? null);
    while (visible.length < AGENT_CHAT_HISTORY_PAGE_SIZE) {
      const load = async (includeTitle: boolean) => {
        let query = actor.db
          .from("agent_sessions")
          .select(includeTitle ? "id, title, updated_at" : "id, updated_at")
          .eq("user_id", actor.userId)
          .eq("portal", portal)
          .eq("kind", PORTAL_CHAT_SESSION_KIND)
          .order("updated_at", { ascending: false })
          .limit(AGENT_CHAT_HISTORY_PAGE_SIZE + 1);
        if (matchingSessionIds) query = query.in("id", matchingSessionIds);
        if (scanCursor) query = query.lt("updated_at", scanCursor);
        return query;
      };
      let { data, error } = await load(true);
      if (error && isMissingTitleColumn(error)) ({ data, error } = await load(false));
      if (error || !data) {
        reportArchiveFailure("list conversations", error);
        return { threads: [], nextCursor: null, error: "Could not load conversations. Try again." };
      }
      const rows = data as { id: string; title?: string | null; updated_at?: string | null }[];
      const candidateRows = rows.slice(0, AGENT_CHAT_HISTORY_PAGE_SIZE);
      if (candidateRows.length === 0) break;

      const sessionIds = candidateRows.map((row) => String(row.id));
      const promptsBySession = new Map<string, string[]>();
      const { data: promptRows, error: promptsError } = await actor.db
        .from("agent_messages")
        .select("session_id, content")
        .in("session_id", sessionIds)
        .eq("role", "user")
        .order("created_at", { ascending: true });
      if (promptsError) {
        // Fail closed with an error — an empty prompts map would filter every
        // real thread out and look like "no history" instead of a load failure.
        reportArchiveFailure("load conversation titles", promptsError);
        return {
          threads: [],
          nextCursor: null,
          error: "Could not load conversations. Try again.",
        };
      }
      for (const row of (promptRows ?? []) as { session_id?: unknown; content?: unknown }[]) {
        if (typeof row.session_id !== "string" || typeof row.content !== "string") continue;
        const prompts = promptsBySession.get(row.session_id) ?? [];
        prompts.push(row.content);
        promptsBySession.set(row.session_id, prompts);
      }

      // Only surface conversations that carry at least one question. A session
      // with no user message is an empty thread the user never sent into (or an
      // orphan from a failed first turn) and must not appear in history.
      for (let index = 0; index < candidateRows.length; index += 1) {
        const row = candidateRows[index]!;
        const prompts = promptsBySession.get(String(row.id)) ?? [];
        if (prompts.length === 0) continue;
        visible.push({
          id: String(row.id),
          title: readGeneratedAgentChatThreadTitle(row.title) ?? agentChatThreadTitleFromPrompts(prompts),
          updatedAt: String(row.updated_at ?? ""),
        });
        if (visible.length === AGENT_CHAT_HISTORY_PAGE_SIZE) {
          const moreInThisFetch = index < candidateRows.length - 1 || rows.length > AGENT_CHAT_HISTORY_PAGE_SIZE;
          return {
            threads: visible,
            nextCursor: moreInThisFetch ? String(row.updated_at ?? "") || null : null,
          };
        }
      }

      if (rows.length <= AGENT_CHAT_HISTORY_PAGE_SIZE) break;
      const continueFrom = String(candidateRows.at(-1)?.updated_at ?? "");
      if (!continueFrom || continueFrom === scanCursor) break;
      scanCursor = continueFrom;
    }
    return { threads: visible, nextCursor: null };
  } catch (error) {
    reportArchiveFailure("list conversations", error);
    return { threads: [], nextCursor: null, error: "Could not load conversations. Try again." };
  }
}

/** Delete one owned portal transcript and cancel any still-unconfirmed draft attached to it. */
export async function deleteAgentChatThread(
  actor: AgentChatHistoryActor,
  portal: AgentPortal,
  sessionId: string,
): Promise<AgentChatThreadDeleteResult> {
  if (!isAgentChatSessionId(sessionId)) return { ok: false };
  try {
    const { data: ownedSession, error: lookupError } = await actor.db
      .from("agent_sessions")
      .select("id")
      .eq("id", sessionId)
      .eq("user_id", actor.userId)
      .eq("portal", portal)
      .eq("kind", PORTAL_CHAT_SESSION_KIND)
      .maybeSingle();
    if (lookupError) {
      reportArchiveFailure("find conversation to delete", lookupError);
      return { ok: false, error: "Could not delete the conversation. Try again." };
    }
    if (!ownedSession?.id) return { ok: false };

    const now = new Date().toISOString();
    const { error: cancelError } = await actor.db
      .from("agent_pending_actions")
      .update({ status: "denied", resolved_at: now })
      .eq("session_id", sessionId)
      .eq("user_id", actor.userId)
      .eq("portal", portal)
      .eq("status", "proposed");
    if (cancelError) {
      reportArchiveFailure("cancel conversation action", cancelError);
      return { ok: false, error: "Could not delete the conversation. Try again." };
    }

    const { data, error } = await actor.db
      .from("agent_sessions")
      .delete()
      .eq("id", sessionId)
      .eq("user_id", actor.userId)
      .eq("portal", portal)
      .eq("kind", PORTAL_CHAT_SESSION_KIND)
      .select("id")
      .maybeSingle();
    if (error) {
      reportArchiveFailure("delete conversation", error);
      return { ok: false, error: "Could not delete the conversation. Try again." };
    }
    return data?.id ? { ok: true } : { ok: false };
  } catch (error) {
    reportArchiveFailure("delete conversation", error);
    return { ok: false, error: "Could not delete the conversation. Try again." };
  }
}

/** Return a single transcript only after the session's actor + portal + kind match. */
export async function loadAgentChatTranscript(
  actor: AgentChatHistoryActor,
  portal: AgentPortal,
  sessionId: string,
): Promise<AgentChatTranscript | null> {
  if (!isAgentChatSessionId(sessionId)) return null;
  try {
    const loadSession = async (includeTitle: boolean) =>
      actor.db
        .from("agent_sessions")
        .select(includeTitle ? "id, title, updated_at" : "id, updated_at")
        .eq("id", sessionId)
        .eq("user_id", actor.userId)
        .eq("portal", portal)
        .eq("kind", PORTAL_CHAT_SESSION_KIND)
        .maybeSingle();
    let { data: session, error: sessionError } = await loadSession(true);
    if (sessionError && isMissingTitleColumn(sessionError)) {
      ({ data: session, error: sessionError } = await loadSession(false));
    }
    if (sessionError || !session?.id) return null;

    const now = new Date().toISOString();
    const [{ data: messageRows, error: messagesError }, { data: actionRows, error: actionsError }] = await Promise.all([
      actor.db.from("agent_messages").select("role, content").eq("session_id", sessionId).order("created_at", { ascending: true }),
      actor.db
        .from("agent_pending_actions")
        .select("id, preview")
        .eq("session_id", sessionId)
        .eq("user_id", actor.userId)
        .eq("portal", portal)
        .eq("status", "proposed")
        .gt("expires_at", now)
        .order("created_at", { ascending: false })
        .limit(1),
    ]);
    if (messagesError) return null;
    const messages = ((messageRows ?? []) as { role?: string; content?: string }[])
      .filter((row): row is { role: "user" | "assistant"; content: string } =>
        (row.role === "user" || row.role === "assistant") && typeof row.content === "string" && row.content.trim().length > 0,
      )
      .map((row) => ({ role: row.role, content: row.content }));
    const action = actionsError ? null : (actionRows ?? [])[0] as { id?: string; preview?: ActionPreview } | undefined;
    return {
      id: String(session.id),
      title: (() => {
        const prompts = messages.filter((message) => message.role === "user").map((message) => message.content);
        return readGeneratedAgentChatThreadTitle(session.title) ??
          (prompts.length > 0 ? agentChatThreadTitleFromPrompts(prompts) : fallbackTitle(session.title));
      })(),
      updatedAt: String(session.updated_at ?? ""),
      messages,
      pendingAction: action?.id && action.preview ? { id: String(action.id), preview: action.preview } : null,
    };
  } catch {
    return null;
  }
}
