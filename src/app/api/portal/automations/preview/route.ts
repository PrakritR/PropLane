import { NextResponse } from "next/server";
import { isAutomationPresetId } from "@/lib/automations/presets";
import { buildAutomationPreview } from "@/lib/automations/preview.server";
import { requireKnowledgeActor } from "@/lib/one-number/knowledge/route-auth.server";

export const runtime = "nodejs";

/** Body: `{ preset, template? }`. The text the preset would send, from one real resident when there is one. */
export async function POST(req: Request) {
  const auth = await requireKnowledgeActor();
  if (!auth.ok) return auth.response;
  let body: { preset?: unknown; template?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  if (!isAutomationPresetId(body.preset)) return NextResponse.json({ error: "Choose an automation." }, { status: 400 });
  const preview = await buildAutomationPreview(auth.actor.db, {
    ownerUserId: auth.actor.ownerUserId,
    workspaceId: auth.actor.workspaceId,
    preset: body.preset,
    template: typeof body.template === "string" ? body.template : undefined,
  });
  return preview.ok ? NextResponse.json(preview) : NextResponse.json({ error: preview.error }, { status: 400 });
}
