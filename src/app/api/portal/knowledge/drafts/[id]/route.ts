import { NextResponse } from "next/server";
import { requireKnowledgeActor } from "@/lib/one-number/knowledge/route-auth.server";
import { rejectDraft, reviewAutoReply } from "@/lib/one-number/knowledge/reply-modes.server";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Body: `{ action: "reject" }` for a held draft, or `{ action: "ok" | "corrected" }` for an auto-review reply. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireKnowledgeActor();
  if (!auth.ok) return auth.response;
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "Not found." }, { status: 404 });
  let body: { action?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const { db, workspaceId } = auth.actor;
  let ok = false;
  if (body.action === "reject") ok = await rejectDraft(db, { workspaceId, draftId: id });
  else if (body.action === "ok" || body.action === "corrected") ok = await reviewAutoReply(db, { workspaceId, draftId: id, verdict: body.action });
  else return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "Not found." }, { status: 404 });
}
