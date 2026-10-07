import { NextResponse } from "next/server";

import { resolveWorkspaceListingAttribution, saveWorkspaceListingAttribution } from "@/lib/listing-attribution.server";
import { resolveListingChannelContext } from "@/lib/listing-channels/route-context.server";

export const runtime = "nodejs";

/**
 * Turn "Listed with PropLane" on or off for the workspace. The owner only. On the Free plan the line
 * is always on, so the write is refused rather than stored and silently ignored.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { show?: unknown; workspaceId?: string | null };
  const ctx = await resolveListingChannelContext(request, body.workspaceId).catch(() => null);
  if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  if (!ctx.workspace.owned) return NextResponse.json({ error: "Only the workspace owner can change this." }, { status: 403 });
  if (typeof body.show !== "boolean") return NextResponse.json({ error: "show must be true or false." }, { status: 400 });

  const current = await resolveWorkspaceListingAttribution(ctx.db, ctx.workspace.ownerUserId, ctx.workspace.id);
  if (current.forced) return NextResponse.json({ error: "Listed with PropLane stays on for the Free plan." }, { status: 403 });

  try {
    await saveWorkspaceListingAttribution(ctx.db, ctx.workspace.id, ctx.workspace.ownerUserId, body.show);
  } catch (cause) {
    return NextResponse.json({ error: cause instanceof Error ? cause.message : "Could not save." }, { status: 500 });
  }
  // Already-posted listings pick up the changed text on their next sync (the content hash includes the line).
  return NextResponse.json({ ok: true });
}
