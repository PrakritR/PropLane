import { NextResponse } from "next/server";
import { approveHeldRun, dismissHeldRun } from "@/lib/automations/fire.server";
import { loadRun } from "@/lib/automations/store.server";
import { requireKnowledgeActor } from "@/lib/one-number/knowledge/route-auth.server";

export const runtime = "nodejs";

/** Body: `{ action: "send" | "dismiss" }`. The run must be in the actor's workspace and, for a co-manager, on a house they hold. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireKnowledgeActor();
  if (!auth.ok) return auth.response;
  const { actor } = auth;
  const { id } = await ctx.params;
  let body: { action?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  if (body.action !== "send" && body.action !== "dismiss") {
    return NextResponse.json({ error: "Choose send or dismiss." }, { status: 400 });
  }
  const run = await loadRun(actor.db, actor.workspaceId, id);
  if (!run) return NextResponse.json({ error: "That draft is gone." }, { status: 404 });
  if (actor.allowedPropertyIds) {
    const propertyId = typeof run.property_id === "string" ? run.property_id : "";
    if (!propertyId || !actor.allowedPropertyIds.includes(propertyId)) {
      return NextResponse.json({ error: "That draft is gone." }, { status: 404 });
    }
  }
  if (body.action === "dismiss") {
    const ok = await dismissHeldRun(actor.db, { workspaceId: actor.workspaceId, runId: id });
    return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "That draft was already handled." }, { status: 409 });
  }
  const result = await approveHeldRun(actor.db, { workspaceId: actor.workspaceId, runId: id });
  if (result.ok) return NextResponse.json({ ok: true });
  const status = result.reason === "not_found" ? 404 : result.reason === "retry_later" ? 503 : 409;
  return NextResponse.json({ error: result.message }, { status });
}
