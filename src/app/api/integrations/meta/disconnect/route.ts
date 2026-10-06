import { NextResponse } from "next/server";

import { deleteMetaConnection } from "@/lib/listing-channels/meta/connection.server";
import { resolveListingChannelContext } from "@/lib/listing-channels/route-context.server";

export const runtime = "nodejs";

/** Remove the workspace's stored Meta token. Posts already on Facebook stay; PropLane just stops managing them. */
export async function POST(request: Request) {
  const ctx = await resolveListingChannelContext(request).catch(() => null);
  if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  if (!ctx.workspace.owned) return NextResponse.json({ error: "Only the workspace owner can disconnect Facebook." }, { status: 403 });
  await deleteMetaConnection(ctx.db, ctx.workspace.id);
  await ctx.db
    .from("listing_channel_posts")
    .update({ pending_action: null, updated_at: new Date().toISOString() })
    .eq("workspace_id", ctx.workspace.id)
    .in("channel", ["facebook_page", "instagram"]);
  return NextResponse.json({ ok: true });
}
