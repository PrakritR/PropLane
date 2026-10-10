import type { SupabaseClient } from "@supabase/supabase-js";

/** A poll is stamped at most this often per connection; Airbnb checks a few times a day. */
export const EXPORT_FETCH_STAMP_THROTTLE_MS = 5 * 60_000;

/** Only the channel's own crawler counts as "Airbnb checked PropLane". */
export function isAirbnbFetcher(userAgent: string | null | undefined): boolean {
  return /airbnb/i.test(userAgent ?? "");
}

export function shouldStampExportFetch(input: {
  userAgent: string | null | undefined;
  lastFetchedAt: string | null | undefined;
  now?: Date;
}): boolean {
  if (!isAirbnbFetcher(input.userAgent)) return false;
  const last = input.lastFetchedAt ? Date.parse(input.lastFetchedAt) : NaN;
  if (!Number.isFinite(last)) return true;
  return (input.now ?? new Date()).getTime() - last >= EXPORT_FETCH_STAMP_THROTTLE_MS;
}

/** Best-effort: never throws, never delays the feed beyond one update. */
export async function stampExportFetch(
  db: SupabaseClient,
  connection: { id: string; export_last_fetched_at?: string | null },
  userAgent: string | null | undefined,
  now: Date = new Date(),
): Promise<boolean> {
  try {
    if (!shouldStampExportFetch({ userAgent, lastFetchedAt: connection.export_last_fetched_at, now })) return false;
    const { error } = await db
      .from("external_calendar_connections")
      .update({ export_last_fetched_at: now.toISOString() })
      .eq("id", connection.id);
    return !error;
  } catch {
    return false;
  }
}
