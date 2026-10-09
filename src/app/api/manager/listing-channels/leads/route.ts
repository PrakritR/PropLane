import { NextResponse } from "next/server";

import { listingSiteLeads } from "@/lib/listing-channels/leads.server";
import { isListingChannelId } from "@/lib/listing-channels/registry";
import { resolveListingChannelContext } from "@/lib/listing-channels/route-context.server";

export const runtime = "nodejs";

/**
 * GET `?channel=<listing site id>&workspaceId=`: the tours and applications that arrived through that
 * site's tagged link, for the active workspace only. Same auth and workspace resolution as the
 * Listing sites status read; the property list is the workspace's own, never the request's.
 */
export async function GET(request: Request) {
  const ctx = await resolveListingChannelContext(request).catch(() => null);
  if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const channel = new URL(request.url).searchParams.get("channel")?.trim() ?? "";
  if (!isListingChannelId(channel)) return NextResponse.json({ error: "Unknown listing site." }, { status: 400 });
  try {
    const leads = await listingSiteLeads({ channel, propertyIds: ctx.workspace.propertyIds });
    return NextResponse.json(
      { workspaceId: ctx.workspace.id, channel, leads },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (cause) {
    return NextResponse.json({ error: cause instanceof Error ? cause.message : "Could not load leads." }, { status: 500 });
  }
}
