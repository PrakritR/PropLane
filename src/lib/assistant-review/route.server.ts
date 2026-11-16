import "server-only";

import { NextResponse } from "next/server";
import {
  correctReply,
  flagReply,
  listOpenReviews,
  loadThreadReview,
  pauseAssistantThread,
  resolveFlag,
  resumeAssistantThread,
  type ReviewActor,
} from "@/lib/assistant-review/store.server";
import { isReviewThreadKey } from "@/lib/assistant-review/model";
import type { SharedLineRole } from "@/lib/one-number/contracts";
import type { KnowledgeAudience } from "@/lib/one-number/knowledge/types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_STORE = { "Cache-Control": "private, no-store" } as const;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * The one request handler behind the manager route and the admin route. Each route re-derives the actor (who is signed in,
 * which workspace, whose workspace owner) before calling here; nothing in the body names a workspace or an owner. A thread
 * key names a conversation INSIDE the actor's own workspace: every row is workspace-scoped, so a key from somewhere else
 * reads and changes nothing of anyone else's.
 */
export async function handleAssistantReviewGet(actor: ReviewActor, url: URL): Promise<NextResponse> {
  if (url.searchParams.get("view") === "list") {
    const rows = await listOpenReviews(actor.db, actor.workspaceId);
    return rows ? NextResponse.json({ rows }, { headers: NO_STORE }) : NextResponse.json({ error: "Unavailable." }, { status: 503 });
  }
  const threadKey = str(url.searchParams.get("threadKey"));
  if (!isReviewThreadKey(threadKey)) return NextResponse.json({ error: "Conversation is required." }, { status: 400 });
  const state = await loadThreadReview(actor.db, actor.workspaceId, threadKey);
  return state ? NextResponse.json(state, { headers: NO_STORE }) : NextResponse.json({ error: "Unavailable." }, { status: 503 });
}

export async function handleAssistantReviewPost(actor: ReviewActor, request: Request): Promise<NextResponse> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const action = str(body.action);
  const threadKey = str(body.threadKey);
  const fail = (e: { error: string; status: number }) => NextResponse.json({ error: e.error }, { status: e.status });
  if (action === "flag") {
    const out = await flagReply(actor, { threadKey, messageRef: str(body.messageRef), reason: str(body.reason), agentText: str(body.agentText) });
    return out.ok ? NextResponse.json({ ok: true, id: out.id, auditRecorded: out.auditRecorded }) : fail(out);
  }
  if (action === "correct") {
    const audience: KnowledgeAudience = body.audience === "all" || body.audience === "team" ? body.audience : "residents";
    const out = await correctReply(actor, {
      threadKey,
      messageRef: str(body.messageRef),
      question: str(body.question),
      correction: str(body.correction),
      propertyId: str(body.propertyId) || null,
      audience,
      agentText: str(body.agentText),
    });
    return out.ok ? NextResponse.json({ ok: true, id: out.id, knowledgeEntryId: out.knowledgeEntryId, auditRecorded: out.auditRecorded }) : fail(out);
  }
  if (action === "pause" || action === "takeover") {
    const role = ["prospect", "resident", "applicant", "vendor"].includes(str(body.role)) ? (str(body.role) as SharedLineRole) : null;
    const out = await pauseAssistantThread(actor, { threadKey, reason: action === "takeover" ? "takeover" : "paused", role });
    return out.ok ? NextResponse.json({ ok: true, paused: true, auditRecorded: out.auditRecorded }) : fail(out);
  }
  if (action === "resume") {
    const out = await resumeAssistantThread(actor, { threadKey });
    return out.ok ? NextResponse.json({ ok: true, paused: false, auditRecorded: out.auditRecorded }) : fail(out);
  }
  if (action === "resolve") {
    const id = str(body.id);
    if (!UUID.test(id)) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const out = await resolveFlag(actor, id);
    return out.ok ? NextResponse.json({ ok: true }) : fail(out);
  }
  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}
