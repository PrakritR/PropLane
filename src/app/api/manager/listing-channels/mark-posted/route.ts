import { NextResponse } from "next/server";

import { isListingChannelId, listingChannelDef } from "@/lib/listing-channels/registry";
import { propertyInWorkspace, resolveListingChannelContext } from "@/lib/listing-channels/route-context.server";

export const runtime = "nodejs";

/** One-click channels: the manager confirms they published the pre-filled post ("Posted by me"). */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { propertyId?: string; channel?: string; posted?: boolean; workspaceId?: string | null };
  const ctx = await resolveListingChannelContext(request, body.workspaceId).catch(() => null);
  if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  if (!ctx.workspace.owned) return NextResponse.json({ error: "Only the workspace owner can change where listings post." }, { status: 403 });

  const def = isListingChannelId(body.channel) ? listingChannelDef(body.channel) : null;
  if (!def || def.group !== "one_click" || typeof body.posted !== "boolean") {
    return NextResponse.json({ error: "Unknown channel." }, { status: 400 });
  }
  const owned = await propertyInWorkspace(ctx.db, ctx.workspace, body.propertyId?.trim() ?? "");
  if (!owned) return NextResponse.json({ error: "Property not found." }, { status: 404 });

  const now = new Date().toISOString();
  const { error } = await ctx.db.from("listing_channel_posts").upsert(
    {
      manager_user_id: ctx.workspace.ownerUserId,
      workspace_id: ctx.workspace.id,
      property_id: owned.id,
      channel: def.id,
      enabled: body.posted,
      state: body.posted ? "posted_by_me" : "off",
      pending_action: null,
      posted_at: body.posted ? now : null,
      updated_at: now,
    },
    { onConflict: "property_id,channel" },
  );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
