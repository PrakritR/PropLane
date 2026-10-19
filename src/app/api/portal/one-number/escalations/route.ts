import { NextResponse } from "next/server";
import { listEscalations, resolveEscalation } from "@/lib/automations/escalations.server";
import { requireKnowledgeActor } from "@/lib/one-number/knowledge/route-auth.server";

export const runtime = "nodejs";

/** `?status=open|resolved`. The workspace is the signed-in actor's; a co-manager sees only their houses. */
export async function GET(req: Request) {
  const auth = await requireKnowledgeActor("read");
  if (!auth.ok) return auth.response;
  const { actor } = auth;
  const status = new URL(req.url).searchParams.get("status") === "resolved" ? "resolved" : "open";
  const items = await listEscalations(actor.db, {
    ownerUserId: actor.ownerUserId,
    workspaceId: actor.workspaceId,
    status,
    allowedPropertyIds: actor.allowedPropertyIds,
  });
  return NextResponse.json({ items });
}

/** Body: `{ id, action: "resolve" | "reopen" }`. */
export async function PATCH(req: Request) {
  const auth = await requireKnowledgeActor();
  if (!auth.ok) return auth.response;
  const { actor } = auth;
  let body: { id?: unknown; action?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  if (typeof body.id !== "string" || !body.id || (body.action !== "resolve" && body.action !== "reopen")) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const ok = await resolveEscalation(actor.db, {
    workspaceId: actor.workspaceId,
    id: body.id,
    userId: actor.userId,
    allowedPropertyIds: actor.allowedPropertyIds,
    reopen: body.action === "reopen",
  });
  return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "Not found." }, { status: 404 });
}
