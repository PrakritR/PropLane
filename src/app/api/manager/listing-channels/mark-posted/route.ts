import { NextResponse } from "next/server";

import { z } from "zod";

import { isMissingColumnError } from "@/lib/db-missing-column";
import { isListingChannelId, listingChannelDef, metaChannelsLive } from "@/lib/listing-channels/registry";
import { propertyInWorkspace, resolveListingChannelContext } from "@/lib/listing-channels/route-context.server";

export const runtime = "nodejs";

const postedUrlSchema = z.string().trim().url().max(500).refine((v) => v.startsWith("https://")).optional();

/** Hand-posted channels: the manager confirms they published the pre-filled post ("Posted by you"), optionally with the ad link. */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { propertyId?: string; channel?: string; posted?: boolean; workspaceId?: string | null; postedUrl?: unknown };
  const ctx = await resolveListingChannelContext(request, body.workspaceId).catch(() => null);
  if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  if (!ctx.workspace.owned) return NextResponse.json({ error: "Only the workspace owner can change where listings post." }, { status: 403 });

  const def = isListingChannelId(body.channel) ? listingChannelDef(body.channel) : null;
  const byHand = def && (def.posting === "manual" || def.posting === "feed" || (def.posting === "api" && !metaChannelsLive()));
  if (!def || !byHand || typeof body.posted !== "boolean") {
    return NextResponse.json({ error: "Unknown channel." }, { status: 400 });
  }
  const urlCheck = postedUrlSchema.safeParse(typeof body.postedUrl === "string" && body.postedUrl.trim() === "" ? undefined : (body.postedUrl ?? undefined));
  if (!urlCheck.success) return NextResponse.json({ error: "The ad link must be a full https:// address." }, { status: 400 });
  const postedUrl = body.posted ? urlCheck.data ?? null : null;
  const owned = await propertyInWorkspace(ctx.db, ctx.workspace, body.propertyId?.trim() ?? "");
  if (!owned) return NextResponse.json({ error: "Property not found." }, { status: 404 });

  const now = new Date().toISOString();
  const base = {
    manager_user_id: ctx.workspace.ownerUserId,
    workspace_id: ctx.workspace.id,
    property_id: owned.id,
    channel: def.id,
    enabled: body.posted,
    state: body.posted ? "posted_by_me" : "off",
    pending_action: null,
    posted_at: body.posted ? now : null,
    updated_at: now,
  };
  // Undo always clears the link; a mark touches the column only when one was given, so a database
  // that has not had `20261008180000_listing_lead_source.sql` applied yet still records the post.
  const writesUrl = !body.posted || postedUrl !== null;
  const save = (values: Record<string, unknown>) =>
    ctx.db.from("listing_channel_posts").upsert(values, { onConflict: "property_id,channel" });

  let { error } = await save(writesUrl ? { ...base, posted_url: postedUrl } : base);
  if (error && writesUrl && isMissingColumnError(error, "posted_url")) {
    ({ error } = await save(base));
  }
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
