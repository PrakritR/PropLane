import { NextResponse } from "next/server";
import { approveSuggestedEntry, dismissSuggestedEntry } from "@/lib/one-number/knowledge/approval.server";
import { houseUsableByActor, requireKnowledgeActor } from "@/lib/one-number/knowledge/route-auth.server";
import { deleteEntry, getEntry, updateEntry } from "@/lib/one-number/knowledge/store.server";
import { isReplyTopic } from "@/lib/one-number/knowledge/topics";
import { asAudience, KNOWLEDGE_AUDIENCES } from "@/lib/one-number/knowledge/types";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Params = { params: Promise<{ id: string }> };

/** The entry must live in the actor's workspace, and a non-owner may only touch their houses. */
async function loadWritable(actor: Awaited<ReturnType<typeof requireKnowledgeActor>> & { ok: true }, id: string) {
  if (!UUID.test(id)) return null;
  const entry = await getEntry(actor.actor.db, actor.actor.workspaceId, id);
  if (!entry) return null;
  if (!actor.actor.isOwner && (!entry.propertyId || !actor.actor.allowedPropertyIds?.includes(entry.propertyId))) return null;
  return entry;
}

/**
 * Body: `{ action: "approve", scope?: "house" | "team", audience?, question?, answer? }`,
 * `{ action: "dismiss" }`, or `{ action: "edit", question?, answer?, topic?, audience?, scope? }`.
 */
export async function PATCH(req: Request, { params }: Params) {
  const auth = await requireKnowledgeActor();
  if (!auth.ok) return auth.response;
  const { actor } = auth;
  const { id } = await params;
  const entry = await loadWritable(auth, id);
  if (!entry) return NextResponse.json({ error: "Not found." }, { status: 404 });
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const action = body.action;
  const scope = body.scope === "team" ? "team" : "house";
  if (scope === "team" && !actor.isOwner) {
    return NextResponse.json({ error: "Only the workspace owner can make an answer team-wide." }, { status: 403 });
  }
  const audience =
    typeof body.audience === "string" && (KNOWLEDGE_AUDIENCES as readonly string[]).includes(body.audience)
      ? asAudience(body.audience)
      : undefined;
  const edits = {
    ...(typeof body.question === "string" && body.question.trim() ? { question: body.question } : {}),
    ...(typeof body.answer === "string" && body.answer.trim() ? { answer: body.answer } : {}),
    ...(isReplyTopic(body.topic) ? { topic: body.topic } : {}),
  };

  if (action === "dismiss") {
    const ok = await dismissSuggestedEntry(actor.db, { workspaceId: actor.workspaceId, entryId: entry.id, actorUserId: actor.userId });
    return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "Already handled." }, { status: 409 });
  }
  if (action === "approve") {
    const houseId = typeof body.propertyId === "string" ? body.propertyId.trim() : "";
    if (houseId && !(await houseUsableByActor(actor, houseId))) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const result = await approveSuggestedEntry(actor.db, {
      workspaceId: actor.workspaceId,
      ownerUserId: actor.ownerUserId,
      entryId: entry.id,
      actorUserId: actor.userId,
      scope,
      audience,
      edits,
      houseId: houseId || null,
    });
    if (!result.ok) {
      const status = result.reason === "not_suggested" ? 409 : result.reason === "no_house" ? 422 : result.reason === "not_found" ? 404 : 503;
      return NextResponse.json({ error: "Could not save that answer." }, { status });
    }
    return NextResponse.json({ entry: result.entry });
  }
  if (action === "edit") {
    let propertyId: string | null | undefined;
    if (body.scope === "team") propertyId = null;
    else if (typeof body.propertyId === "string" && body.propertyId.trim()) {
      if (!(await houseUsableByActor(actor, body.propertyId.trim()))) return NextResponse.json({ error: "Not found." }, { status: 404 });
      propertyId = body.propertyId.trim();
    }
    const updated = await updateEntry(actor.db, {
      workspaceId: actor.workspaceId,
      entryId: entry.id,
      patch: { ...edits, ...(audience ? { audience } : {}), ...(propertyId !== undefined ? { propertyId } : {}) },
    });
    return updated ? NextResponse.json({ entry: updated }) : NextResponse.json({ error: "Could not save." }, { status: 503 });
  }
  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}

export async function DELETE(_req: Request, { params }: Params) {
  const auth = await requireKnowledgeActor();
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const entry = await loadWritable(auth, id);
  if (!entry) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const ok = await deleteEntry(auth.actor.db, auth.actor.workspaceId, entry.id);
  return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "Could not delete." }, { status: 503 });
}
