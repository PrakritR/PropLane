import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getPublicListings } from "@/lib/public-listings.server";
import { buildZillowRentalFeedXml } from "@/lib/listing-syndication/zillow-feed";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * Which of this manager's live property ids opted into Zillow — read from the
 * RAW stored row, never the public projection. `publicListingProjection`
 * deliberately excludes `syndication`: it is manager-internal operational
 * state, not prospect-facing copy, so it never belongs on an allowlist every
 * anonymous surface shares.
 */
async function zillowEnabledPropertyIds(db: SupabaseClient, managerUserId: string): Promise<Set<string>> {
  const { data, error } = await db
    .from("manager_property_records")
    .select("id, property_data")
    .eq("manager_user_id", managerUserId)
    .eq("status", "live");
  if (error) throw new Error(error.message);
  const ids = new Set<string>();
  for (const row of (data ?? []) as { id: string; property_data: unknown }[]) {
    const submission = asRecord(asRecord(row.property_data)?.listingSubmission);
    const zillow = asRecord(asRecord(submission?.syndication)?.zillow);
    if (zillow?.enabled === true) ids.add(row.id);
  }
  return ids;
}

/**
 * Public, anonymous Zillow Rental Network feed for one manager account.
 * `feedKey` is an opaque token (`manager_syndication_feeds.feed_key`), never
 * the manager's user id — the URL alone reveals no identity. Unknown or
 * disabled key: 404, same as any other "this does not exist" public read.
 */
export async function GET(_req: Request, context: { params: Promise<{ feedKey: string }> }) {
  const { feedKey } = await context.params;
  const key = feedKey?.replace(/\.xml$/i, "").trim();
  if (!key) return NextResponse.json({ error: "Not found." }, { status: 404 });

  const db = createSupabaseServiceRoleClient();
  const { data: feed, error } = await db
    .from("manager_syndication_feeds")
    .select("manager_user_id, enabled")
    .eq("feed_key", key)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!feed || feed.enabled !== true) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  try {
    const [listings, enabledIds] = await Promise.all([
      getPublicListings(),
      zillowEnabledPropertyIds(db, feed.manager_user_id),
    ]);
    const scoped = listings.filter(
      (listing) => listing.managerUserId === feed.manager_user_id && enabledIds.has(listing.id),
    );
    const { xml } = buildZillowRentalFeedXml(scoped, resolveEmailLinkBaseUrl());

    // Same CDN posture as the other public listing reads: bounded staleness
    // after a manager toggles a listing on or off the feed.
    return new NextResponse(xml, {
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
        "Cache-Control": "public, s-maxage=60, stale-while-revalidate=600",
      },
    });
  } catch (cause) {
    return NextResponse.json(
      { error: cause instanceof Error ? cause.message : "Failed to build the feed." },
      { status: 500 },
    );
  }
}
