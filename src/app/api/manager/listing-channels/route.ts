import { NextResponse } from "next/server";

import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { isMissingColumnError } from "@/lib/db-missing-column";
import { LISTING_CHANNEL_DEFS, listingChannels, metaAppConfigured } from "@/lib/listing-channels/registry";
import { buildListingPostText, listingChannelEligibility, type ListingHoldReason } from "@/lib/listing-channels/post-text";
import { loadMetaConnectionPublic } from "@/lib/listing-channels/meta/connection.server";
import { propertyInWorkspace, resolveListingChannelContext, toPostRow } from "@/lib/listing-channels/route-context.server";
import { loadSyncListing, resolveListingPostContact } from "@/lib/listing-channels/sync.server";
import { leadCountsByChannel } from "@/lib/listing-channels/lead-counts.server";
import { resolveWorkspaceListingAttribution } from "@/lib/listing-attribution.server";

export const runtime = "nodejs";

/** Zillow approves PropLane's feed once for the whole deployment, so this is an env flag. */
function zillowFeedApproved(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.ZILLOW_FEED_APPROVED?.trim().toLowerCase();
  return v === "1" || v === "true";
}

const POST_COLUMNS ="property_id, channel, enabled, state, external_id, last_error, posted_at, posted_url, updated_at";
/** Same read for a database that has not had `20261008180000_listing_lead_source.sql` applied yet. */
const POST_COLUMNS_BEFORE_POSTED_URL = "property_id, channel, enabled, state, external_id, last_error, posted_at, updated_at";

/**
 * GET: everything the Listing sites surfaces need for the active workspace, in one read: which
 * channels are live, the Meta connection (never its token), the workspace work contact, and the
 * per-listing posting rows. With `?propertyId=` it also returns that listing's hold reasons and the
 * ready-to-copy post text for every channel that is posted by hand, built from `publicListingProjection` only.
 */
export async function GET(request: Request) {
  const ctx = await resolveListingChannelContext(request).catch(() => null);
  if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const { db, workspace } = ctx;
  const propertyId = new URL(request.url).searchParams.get("propertyId")?.trim() || "";

  try {
    const [meta, contact, attributionState, leadCounts, postsRes] = await Promise.all([
      loadMetaConnectionPublic(db, workspace.id),
      resolveListingPostContact(db, workspace.ownerUserId, workspace.id),
      resolveWorkspaceListingAttribution(db, workspace.ownerUserId, workspace.id),
      leadCountsByChannel({ workspaceId: workspace.id, propertyId: propertyId || undefined }).catch(() => ({}) as Record<string, number>),
      (async () => {
        const read = async (columns: string) => {
          let q = db
            .from("listing_channel_posts")
            .select(columns)
            .eq("manager_user_id", workspace.ownerUserId)
            .eq("workspace_id", workspace.id);
          if (propertyId) q = q.eq("property_id", propertyId);
          const { data, error } = await q;
          return { rows: (data ?? []) as unknown as Record<string, unknown>[], error };
        };
        const full = await read(POST_COLUMNS);
        if (!isMissingColumnError(full.error, "posted_url")) return { ...full, migrated: true };
        // The new column is not there yet: read the rest of the row rather than
        // reporting the whole page as broken, and say the schema is not ready.
        return { ...(await read(POST_COLUMNS_BEFORE_POSTED_URL)), migrated: false };
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
        const { show: attribution } = attributionState;
        for (const def of LISTING_CHANNEL_DEFS.filter((d) => d.posting !== "partner_only")) {
          const built = buildListingPostText({ property: listing.projected, origin, contact, channel: def.id, attribution });
          if (built.ok) postTexts[def.id] = built.text;
        }
        property = { id: propertyId, live: listing.live, holdReasons, postTexts };
      }
    }

    return NextResponse.json(
      {
        workspaceId: workspace.id,
        canManage: workspace.owned,
        // A table or column that is not migrated yet reads as "no posts" / "no ad link", never as a
        // failure of the page.
        schemaReady: !postsRes.error && postsRes.migrated,
        // Read here (server only): registry.ts is imported by client components.
        zillowFeedApproved: zillowFeedApproved(),
        channels,
        meta: { configured: metaAppConfigured(), ...meta },
        workContact: contact,
        // The "Listed with PropLane" switch: what it shows, and whether the plan pins it on.
        attribution: { enabled: attributionState.show, forced: attributionState.forced },
        // Leads that arrived through a tagged (?src=<channel>) link, per channel.
        leadCounts,
        posts: postsRes.rows.map(toPostRow),
        property,
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (cause) {
    return NextResponse.json({ error: cause instanceof Error ? cause.message : "Could not load listing sites." }, { status: 500 });
  }
}
