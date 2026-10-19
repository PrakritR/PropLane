import { NextResponse } from "next/server";
import { normalizeConsentPhone } from "@/lib/sms-consent";
import { requireKnowledgeActor } from "@/lib/one-number/knowledge/route-auth.server";
import { loadThreadKnowledge } from "@/lib/one-number/knowledge/thread.server";

export const runtime = "nodejs";

/** `?phone=<counterparty phone>`: what the Communication thread shows beside a conversation. */
export async function GET(req: Request) {
  const auth = await requireKnowledgeActor("read");
  if (!auth.ok) return auth.response;
  const phoneKey = normalizeConsentPhone(new URL(req.url).searchParams.get("phone") ?? "");
  if (!phoneKey) return NextResponse.json({ error: "A phone is required." }, { status: 400 });
  const data = await loadThreadKnowledge(auth.actor.db, {
    workspaceId: auth.actor.workspaceId,
    ownerUserId: auth.actor.ownerUserId,
    phoneKey,
    allowedPropertyIds: auth.actor.allowedPropertyIds,
  });
  return NextResponse.json({ ...data, canManageTeam: auth.actor.isOwner });
}
