import { NextResponse } from "next/server";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { requireKnowledgeActor } from "@/lib/one-number/knowledge/route-auth.server";
import { resolveEscalationContact, saveEscalationContactEnabled } from "@/lib/one-number/escalation-contact.server";

export const runtime = "nodejs";

/**
 * The "Share my phone when the assistant can't answer" setting of the ACTIVE workspace (derived from the session, never a
 * body id). On a PropLane-managed workspace the number is the operator's and only an admin may change the toggle.
 */
async function view(actor: { db: Parameters<typeof resolveEscalationContact>[0]; workspaceId: string; ownerUserId: string; userId: string; isOwner: boolean }) {
  const contact = await resolveEscalationContact(actor.db, { ownerUserId: actor.ownerUserId, workspaceId: actor.workspaceId });
  const canEdit = contact.kind === "managed" ? await isAdminUser(actor.userId).catch(() => false) : actor.isOwner;
  // The number is the owner's own verified mobile (the operator's on a managed workspace): only whoever may change
  // this setting reads it. A Communication-read teammate sees the setting, never the personal number behind it.
  return { enabled: contact.enabled, phone: canEdit ? contact.phoneDisplay : null, managed: contact.kind === "managed", canEdit };
}

export async function GET() {
  const auth = await requireKnowledgeActor("read");
  if (!auth.ok) return auth.response;
  return NextResponse.json(await view(auth.actor));
}

/** Body: `{ enabled: boolean }`. */
export async function PUT(req: Request) {
  const auth = await requireKnowledgeActor();
  if (!auth.ok) return auth.response;
  let body: { enabled?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  if (typeof body.enabled !== "boolean") return NextResponse.json({ error: "Choose on or off." }, { status: 400 });
  const current = await view(auth.actor);
  if (!current.canEdit) {
    return NextResponse.json({ error: current.managed ? "Only a PropLane admin can change this." : "Only the workspace owner can change this." }, { status: 403 });
  }
  try {
    await saveEscalationContactEnabled(auth.actor.db, auth.actor.workspaceId, auth.actor.ownerUserId, body.enabled);
  } catch {
    return NextResponse.json({ error: "Could not save." }, { status: 503 });
  }
  return NextResponse.json(await view(auth.actor));
}
