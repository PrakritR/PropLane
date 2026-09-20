import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import {
  buildZillowFeedUrl,
  getOrCreateManagerSyndicationFeedKey,
} from "@/lib/listing-syndication/manager-syndication-feed.server";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";

export const runtime = "nodejs";

async function requireUser() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

/**
 * GET — this manager's Zillow Rental Network feed URL, creating the feed row
 * on first read. Always the canonical production origin: Zillow's crawler
 * hits this URL from the outside, so it can never resolve to localhost or a
 * preview deploy the way a request-derived origin could.
 */
export async function GET() {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const db = createSupabaseServiceRoleClient();
  try {
    const feedKey = await getOrCreateManagerSyndicationFeedKey(db, user.id);
    return NextResponse.json({ feedUrl: buildZillowFeedUrl(resolveEmailLinkBaseUrl(), feedKey) });
  } catch (cause) {
    return NextResponse.json(
      { error: cause instanceof Error ? cause.message : "Could not load the feed URL." },
      { status: 500 },
    );
  }
}
