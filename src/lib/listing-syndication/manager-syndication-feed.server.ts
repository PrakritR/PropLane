import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Lazily create the manager's own Zillow Rental Network feed row on first
 * read, then keep returning the same `feed_key` forever — `manager_id` is
 * unique, and regenerating the key is deliberately out of scope (a manager
 * has already handed Zillow this exact URL). `manager_syndication_feeds` is
 * service-role only (no client-role grants), so every read/write here goes
 * through the service-role client, pinned to the caller's own `managerUserId`
 * — never a value from the request body.
 */
export async function getOrCreateManagerSyndicationFeedKey(
  db: SupabaseClient,
  managerUserId: string,
): Promise<string> {
  const { data: existing, error: selectError } = await db
    .from("manager_syndication_feeds")
    .select("feed_key")
    .eq("manager_user_id", managerUserId)
    .maybeSingle();
  if (selectError) throw new Error(selectError.message);
  if (existing?.feed_key) return existing.feed_key as string;

  const { data: inserted, error: insertError } = await db
    .from("manager_syndication_feeds")
    .insert({ manager_user_id: managerUserId })
    .select("feed_key")
    .single();
  if (insertError) {
    // Another request may have created the row between the select and the
    // insert above (the unique index on manager_user_id rejects the second
    // writer) — read back rather than surfacing a spurious failure.
    const { data: retry } = await db
      .from("manager_syndication_feeds")
      .select("feed_key")
      .eq("manager_user_id", managerUserId)
      .maybeSingle();
    if (retry?.feed_key) return retry.feed_key as string;
    throw new Error(insertError.message);
  }
  return inserted.feed_key as string;
}

/** The full, public feed URL a manager pastes into Zillow's feed registration. */
export function buildZillowFeedUrl(origin: string, feedKey: string): string {
  return `${origin.replace(/\/$/, "")}/api/feeds/zillow/${encodeURIComponent(feedKey)}`;
}
