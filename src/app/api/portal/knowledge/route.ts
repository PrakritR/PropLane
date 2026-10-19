import { NextResponse } from "next/server";
import { houseUsableByActor, requireKnowledgeActor } from "@/lib/one-number/knowledge/route-auth.server";
import { createEntry, listEntries } from "@/lib/one-number/knowledge/store.server";
import { isReplyTopic, classifyTopic } from "@/lib/one-number/knowledge/topics";
import { asAudience } from "@/lib/one-number/knowledge/types";

export const runtime = "nodejs";

/**
 * List knowledge for the active workspace.
 * `?propertyId=<id>` = that house; `?scope=team` = team-wide answers; neither = everything the actor may see (a teammate: team-wide + their houses).
 */
export async function GET(req: Request) {
  const auth = await requireKnowledgeActor("read");
  if (!auth.ok) return auth.response;
  const { actor } = auth;
  const params = new URL(req.url).searchParams;
  const propertyId = params.get("propertyId")?.trim() ?? "";
  const team = params.get("scope") === "team";
  if (propertyId) {
    if (actor.allowedPropertyIds && !actor.allowedPropertyIds.includes(propertyId)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (!(await houseUsableByActor({ ...actor, allowedPropertyIds: null }, propertyId))) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
  }
  const entries = await listEntries(actor.db, {
    workspaceId: actor.workspaceId,
    propertyId: propertyId ? propertyId : team ? null : undefined,
    statuses: ["approved", "suggested"],
  });
  // A teammate sees team-wide answers and their own houses' answers, never another house's.
  const allowed = actor.allowedPropertyIds;
  const visible = allowed ? entries.filter((entry) => entry.propertyId === null || allowed.includes(entry.propertyId)) : entries;
  return NextResponse.json({ entries: visible, canManageTeam: actor.isOwner });
}

/** Add an answer by hand. Approved straight away: the manager typed it. */
export async function POST(req: Request) {
  const auth = await requireKnowledgeActor();
  if (!auth.ok) return auth.response;
  const { actor } = auth;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const question = typeof body.question === "string" ? body.question.trim() : "";
  const answer = typeof body.answer === "string" ? body.answer.trim() : "";
  if (!question || !answer) return NextResponse.json({ error: "A question and an answer are required." }, { status: 400 });
  const propertyId = typeof body.propertyId === "string" && body.propertyId.trim() ? body.propertyId.trim() : null;
  if (propertyId === null && !actor.isOwner) {
    return NextResponse.json({ error: "Only the workspace owner can add team-wide answers." }, { status: 403 });
  }
  if (propertyId && !(await houseUsableByActor(actor, propertyId))) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  const topic = isReplyTopic(body.topic) ? body.topic : classifyTopic(question);
  const created = await createEntry(actor.db, {
    workspaceId: actor.workspaceId,
    propertyId,
    topic,
    question,
    answer,
    status: "approved",
    source: "manual",
    audience: asAudience(body.audience),
    createdBy: actor.userId,
  });
  if (!created.ok) return NextResponse.json({ error: "Could not save that answer." }, { status: 503 });
  return NextResponse.json({ entry: created.entry }, { status: 201 });
}
