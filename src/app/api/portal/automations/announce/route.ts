import { NextResponse } from "next/server";
import { announceToHouses } from "@/lib/automations/announce.server";
import { requireKnowledgeActor } from "@/lib/one-number/knowledge/route-auth.server";

export const runtime = "nodejs";

/**
 * Body: `{ text, houseIds | "all" }`. The workspace and the houses the actor may reach come from the
 * session; a house id in the body only narrows within them. A fresh announcement id per request so a
 * double click of Send is the client's problem (the button disables), not a silent repeat.
 */
export async function POST(req: Request) {
  const auth = await requireKnowledgeActor();
  if (!auth.ok) return auth.response;
  const { actor } = auth;
  let body: { text?: unknown; houseIds?: unknown; announcementId?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const text = typeof body.text === "string" ? body.text : "";
  const propertyIds =
    body.houseIds === "all"
      ? ("all" as const)
      : Array.isArray(body.houseIds)
        ? body.houseIds.filter((id): id is string => typeof id === "string" && id.length > 0).slice(0, 60)
        : [];
  const result = await announceToHouses(actor.db, {
    ownerUserId: actor.ownerUserId,
    workspaceId: actor.workspaceId,
    allowedPropertyIds: actor.allowedPropertyIds,
    propertyIds,
    text,
    ...(typeof body.announcementId === "string" && body.announcementId.length <= 80 ? { announcementId: body.announcementId } : {}),
  });
  if (!result.ok) return NextResponse.json({ error: result.message, houses: result.houses }, { status: 400 });
  return NextResponse.json(result);
}
