import { NextResponse } from "next/server";

import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { listingChannels, metaAppConfigured, listingChannelsByGroup } from "@/lib/listing-channels/registry";
import { buildListingPostText, listingChannelEligibility, type ListingHoldReason } from "@/lib/listing-channels/post-text";
import { loadMetaConnectionPublic } from "@/lib/listing-channels/meta/connection.server";
import { propertyInWorkspace, resolveListingChannelContext, toPostRow } from "@/lib/listing-channels/route-context.server";
import { loadSyncListing, resolveListingPostContact } from "@/lib/listing-channels/sync.server";

export const runtime = "nodejs";

/**
 * GET: everything the Listing sites surfaces need for the active workspace, in one read: which
 * channels are live, the Meta connection (never its token), the workspace work contact, and the
 * per-listing posting rows. With `?propertyId=` it also returns that listing's hold reasons and the
 * ready-to-copy post text for the one-click channels, built from `publicListingProjection` only.
 */
export async function GET(request: Request) {
  const ctx = await resolveListingChannelContext(request).catch(() => null);
  if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const { db, workspace } = ctx;
  const propertyId = new URL(request.url).searchParams.get("propertyId")?.trim() || "";

  try {
    const [meta, contact, postsRes] = await Promise.all([
      loadMetaConnectionPublic(db, workspace.id),
      resolveListingPostContact(db, workspace.ownerUserId, workspace.id),
      (() => {
        let q = db
          .from("listing_channel_posts")
          .select("property_id, channel, enabled, state, external_id, last_error, posted_at, updated_at")
          .eq("manager_user_id", workspace.ownerUserId)
          .eq("workspace_id", workspace.id);
        if (propertyId) q = q.eq("property_id", propertyId);
        return q;
      })(),
    ]);

    const channels = listingChannels().map((c) => ({ id: c.id, availability: c.availability }));
    let property: { id: string; live: boolean; holdReasons: ListingHoldReason[]; postTexts: Record<string, string> } | null = null;
    if (propertyId) {
      const owned = await propertyInWorkspace(db, workspace, propertyId);
      if (!owned) return NextResponse.json({ error: "Property not found." }, { status: 404 });
      const listing = await loadSyncListing(db, propertyId);
      if (listing) {
        const holdReasons = listingChannelEligibility(listing.projected);
        if (!contact.phone?.trim()) holdReasons.push("no_work_number");
        const postTexts: Record<string, string> = {};
        const origin = resolveEmailLinkBaseUrl();
        for (const def of listingChannelsByGroup("one_click")) {
          const built = buildListingPostText({ property: listing.projected, origin, contact, channel: def.id });
          if (built.ok) postTexts[def.id] = built.text;
        }
        property = { id: propertyId, live: listing.live, holdReasons, postTexts };
      }
    }

    return NextResponse.json(
      {
        workspaceId: workspace.id,
        canManage: workspace.owned,
        // A table that is not migrated yet reads as "no posts", never as a failure of the page.
        schemaReady: !postsRes.error,
        channels,
        meta: { configured: metaAppConfigured(), ...meta },
        workContact: contact,
        posts: (postsRes.data ?? []).map((row) => toPostRow(row as Record<string, unknown>)),
        property,
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (cause) {
    return NextResponse.json({ error: cause instanceof Error ? cause.message : "Could not load listing sites." }, { status: 500 });
  }
}
