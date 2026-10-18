import { NextResponse } from "next/server";
import { ANNOUNCE_MAX_CHARS, announceOutcomeLine, announceToHouses } from "@/lib/house-groups/announce.server";
import { syncHouseGroup } from "@/lib/house-groups/manager.server";
import { selectGroupMembers } from "@/lib/house-groups/members";
import { loadHouseResidentCandidates } from "@/lib/house-groups/residents.server";
import { loadActiveGroup, loadMembers, loadSettings, saveSettings } from "@/lib/house-groups/store.server";
import { pacificDayKey } from "@/lib/house-groups/time";
import { propertyInWorkspace, resolveListingChannelContext } from "@/lib/listing-channels/route-context.server";
import { readSharedLineConfig, sharedLineActiveFor } from "@/lib/one-number/shared-line-number.server";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * House chat for one house: who is in the group (first name + room), whether it is on, the over-nine
 * warning, and the Announce / Refresh actions. The workspace comes from the signed-in manager; the house
 * is re-checked against it. While the line is not shared for this workspace the answer is 404, so the
 * section simply does not draw.
 */
export async function GET(request: Request) {
  const ctx = await resolveListingChannelContext(request).catch(() => null);
  if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const config = await readSharedLineConfig(ctx.db);
  if (!sharedLineActiveFor(config, ctx.workspace.id)) return NextResponse.json({ error: "Not available." }, { status: 404 });

  const propertyId = new URL(request.url).searchParams.get("propertyId")?.trim() ?? "";
  if (!propertyId || !(await propertyInWorkspace(ctx.db, ctx.workspace, propertyId))) {
    return NextResponse.json({ error: "Property not found." }, { status: 404 });
  }
  const settings = await loadSettings(ctx.db, ctx.workspace.id);
  const group = settings.enabled ? await loadActiveGroup(ctx.db, propertyId) : null;
  const members = group ? await loadMembers(ctx.db, group.id) : [];

  let overflow = 0;
  let waiting = 0;
  if (settings.enabled) {
    try {
      const candidates = await loadHouseResidentCandidates(ctx.db, {
        ownerUserId: ctx.workspace.ownerUserId,
        workspaceId: ctx.workspace.id,
        propertyId,
        today: pacificDayKey(new Date()),
      });
      overflow = selectGroupMembers(candidates).overflow.length;
      waiting = candidates.filter((c) => c.longTerm && !c.stopped && !c.optedOut && (!c.consented || !c.verifiedPhone)).length;
    } catch {
      /* the list still draws without the warnings */
    }
  }
  return NextResponse.json({
    enabled: settings.enabled,
    maxPostsPerDay: settings.maxPostsPerDay,
    canManage: ctx.userId === ctx.workspace.ownerUserId,
    group: group ? { members: members.map((m) => ({ firstName: m.firstName, roomLabel: m.roomLabel })) } : null,
    overflow,
    waiting,
  });
}

type PostBody = {
  action?: unknown;
  propertyId?: unknown;
  text?: unknown;
  requestId?: unknown;
  enabled?: unknown;
  maxPostsPerDay?: unknown;
  workspaceId?: unknown;
};

/** POST `{ action: "settings" | "sync" | "announce", propertyId, ... }`. Settings are the workspace owner's. */
export async function POST(request: Request) {
  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const ctx = await resolveListingChannelContext(request, typeof body.workspaceId === "string" ? body.workspaceId : null).catch(() => null);
  if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const config = await readSharedLineConfig(ctx.db);
  if (!sharedLineActiveFor(config, ctx.workspace.id)) return NextResponse.json({ error: "Not available." }, { status: 404 });

  const action = typeof body.action === "string" ? body.action : "";
  const propertyId = typeof body.propertyId === "string" ? body.propertyId.trim() : "";

  if (action === "settings") {
    if (ctx.userId !== ctx.workspace.ownerUserId) return NextResponse.json({ error: "Only the workspace owner can change house chat." }, { status: 403 });
    const saved = await saveSettings(ctx.db, ctx.workspace.id, ctx.userId, {
      ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
      ...(typeof body.maxPostsPerDay === "number" ? { maxPostsPerDay: body.maxPostsPerDay } : {}),
    });
    if (!saved.ok) return NextResponse.json({ error: "Could not save." }, { status: 503 });
    return NextResponse.json({ ok: true, ...saved.settings });
  }

  if (!propertyId || !(await propertyInWorkspace(ctx.db, ctx.workspace, propertyId))) {
    return NextResponse.json({ error: "Property not found." }, { status: 404 });
  }

  if (action === "sync") {
    const result = await syncHouseGroup(ctx.db, { workspaceId: ctx.workspace.id, propertyId, reason: "manager" });
    return NextResponse.json({ ok: true, outcome: result.outcome, members: result.members, overflow: result.overflow });
  }

  if (action === "announce") {
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return NextResponse.json({ error: "Write the announcement first." }, { status: 400 });
    if (text.length > ANNOUNCE_MAX_CHARS) return NextResponse.json({ error: `Keep it under ${ANNOUNCE_MAX_CHARS} characters.` }, { status: 400 });
    const requestId = typeof body.requestId === "string" && body.requestId.trim() ? body.requestId.trim().slice(0, 64) : `${ctx.userId}:${Date.now()}`;
    const outcomes = await announceToHouses(ctx.db, { workspaceId: ctx.workspace.id, propertyIds: [propertyId], text, requestKey: requestId });
    const posted = outcomes.every((o) => o.result.ok);
    return NextResponse.json({ ok: posted, message: announceOutcomeLine(outcomes) }, { status: posted ? 200 : 409 });
  }

  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}
