import { NextResponse } from "next/server";
import type { AgentPortal } from "@/lib/tools/pending-actions";
import {
  isAgentChatSessionId,
  deleteAgentChatThread,
  listAgentChatThreads,
  loadAgentChatTranscript,
  type AgentChatHistoryActor,
  type AgentChatHistoryScope,
} from "@/lib/agent/chat-history";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store" };

/** Shared GET behavior for the three role-scoped chat endpoints. */
export async function handleAgentChatHistoryRequest(
  req: Request,
  actor: AgentChatHistoryActor,
  portal: AgentPortal,
  scope?: AgentChatHistoryScope,
): Promise<NextResponse> {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("sessionId");
  if (sessionId) {
    if (!isAgentChatSessionId(sessionId)) {
      return NextResponse.json({ error: "Invalid conversation." }, { status: 400, headers: PRIVATE_HEADERS });
    }
    const conversation = await loadAgentChatTranscript(actor, portal, sessionId, scope);
    if (!conversation) {
      // Do not distinguish another user's session from an unknown id.
      return NextResponse.json({ error: "Conversation not found." }, { status: 404, headers: PRIVATE_HEADERS });
    }
    return NextResponse.json({ conversation }, { headers: PRIVATE_HEADERS });
  }

  const { threads, nextCursor, error } = await listAgentChatThreads(
    actor,
    portal,
    url.searchParams.get("cursor"),
    url.searchParams.get("search"),
    scope,
  );
  if (error) return NextResponse.json({ error }, { status: 503, headers: PRIVATE_HEADERS });
  return NextResponse.json({ threads, nextCursor }, { headers: PRIVATE_HEADERS });
}

/** Shared DELETE behavior for one actor-owned portal archive item. */
export async function handleAgentChatHistoryDeleteRequest(
  req: Request,
  actor: AgentChatHistoryActor,
  portal: AgentPortal,
  scope?: AgentChatHistoryScope,
): Promise<NextResponse> {
  const sessionId = new URL(req.url).searchParams.get("sessionId");
  if (!isAgentChatSessionId(sessionId)) {
    return NextResponse.json({ error: "Invalid conversation." }, { status: 400, headers: PRIVATE_HEADERS });
  }
  const result = await deleteAgentChatThread(actor, portal, sessionId, scope);
  if (!result.ok) {
    const status = result.error ? 503 : 404;
    return NextResponse.json({ error: result.error ?? "Conversation not found." }, { status, headers: PRIVATE_HEADERS });
  }
  return NextResponse.json({ deleted: true }, { headers: PRIVATE_HEADERS });
}
