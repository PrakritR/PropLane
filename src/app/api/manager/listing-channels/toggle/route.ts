import { NextResponse } from "next/server";

import { apiPostingChannelIds, isListingChannelId, listingChannelAvailability, listingChannelDef } from "@/lib/listing-channels/registry";
import { propertyInWorkspace, resolveListingChannelContext } from "@/lib/listing-channels/route-context.server";
import { scheduleListingChannelSync } from "@/lib/listing-channels/sync.server";

export const runtime = "nodejs";

/** Turn an automatic channel on or off for one listing. The owner of the workspace only. */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { propertyId?: string; channel?: string; enabled?: boolean; workspaceId?: string | null };
  const ctx = await resolveListingChannelContext(request, body.workspaceId).catch(() => null);
  if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  if (!ctx.workspace.owned) return NextResponse.json({ error: "Only the workspace owner can change where listings post." }, { status: 403 });

  const propertyId = body.propertyId?.trim() ?? "";
  if (!isListingChannelId(body.channel) || !apiPostingChannelIds().includes(body.channel) || typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "Unknown channel." }, { status: 400 });
  }
  const def = listingChannelDef(body.channel)!;
  if (listingChannelAvailability(def) !== "live") return NextResponse.json({ error: "This site is coming soon." }, { status: 409 });

  const owned = await propertyInWorkspace(ctx.db, ctx.workspace, propertyId);
  if (!owned) return NextResponse.json({ error: "Property not found." }, { status: 404 });

  const { error } = await ctx.db.from("listing_channel_posts").upsert(
    {
      manager_user_id: ctx.workspace.ownerUserId,
      workspace_id: ctx.workspace.id,
      property_id: owned.id,
      channel: body.channel,
      enabled: body.enabled,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "property_id,channel" },
  );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  scheduleListingChannelSync(ctx.db, owned.id);
  return NextResponse.json({ ok: true });
}
