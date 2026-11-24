import type { SupabaseClient } from "@supabase/supabase-js";

import { isAgodaLabel } from "@/lib/channel-calendar/channel-links";
import { shouldRestamp, SYNC_STAMP_MIN_INTERVAL_MS } from "@/lib/write-skip";

/** A poll is stamped at most this often per connection (production disk IO): channels poll a few times a day. */
export const EXPORT_FETCH_STAMP_THROTTLE_MS = SYNC_STAMP_MIN_INTERVAL_MS;

/** Only the channel's own crawler counts as "Airbnb checked PropLane". */
export function isAirbnbFetcher(userAgent: string | null | undefined): boolean {
  return /airbnb/i.test(userAgent ?? "");
}

/**
 * Whether this request is the connection's OWN channel reading the feed: each platform by NAME in the
 * user-agent, nothing else. "Agoda last fetched" is the only input to the row's "Synced" / "Not pulling"
 * state, so a curl, a link checker or an uptime probe must never stamp it; an unrecognised fetcher reads as
 * "Agoda has not fetched PropLane yet", the honest answer. The export route logs the agent of every fetch on
 * an Agoda link, which is how the real one gets named here.
 */
export function isChannelFetcher(
  userAgent: string | null | undefined,
  provider: string = "airbnb",
  label?: string | null,
): boolean {
  const ua = (userAgent ?? "").trim();
  if (provider === "airbnb") return isAirbnbFetcher(ua);
  if (provider === "booking_com") return /booking/i.test(ua);
  if (provider === "ical" && isAgodaLabel(label)) return /agoda/i.test(ua);
  return false;
}

export function shouldStampExportFetch(input: {
  userAgent: string | null | undefined;
  lastFetchedAt: string | null | undefined;
  provider?: string;
  label?: string | null;
  now?: Date;
}): boolean {
  if (!isChannelFetcher(input.userAgent, input.provider, input.label)) return false;
  return shouldRestamp({
    lastStampIso: input.lastFetchedAt,
    now: input.now ?? new Date(),
    changed: false,
    minIntervalMs: EXPORT_FETCH_STAMP_THROTTLE_MS,
  });
}

/** Best-effort: never throws, never delays the feed beyond one update. */
export async function stampExportFetch(
  db: SupabaseClient,
  connection: { id: string; export_last_fetched_at?: string | null; provider?: string; label?: string | null },
  userAgent: string | null | undefined,
  now: Date = new Date(),
): Promise<boolean> {
  try {
    if (!shouldStampExportFetch({ userAgent, lastFetchedAt: connection.export_last_fetched_at, provider: connection.provider, label: connection.label, now })) return false;
    const { error } = await db
      .from("external_calendar_connections")
      .update({ export_last_fetched_at: now.toISOString() })
      .eq("id", connection.id);
    return !error;
  } catch {
    return false;
  }
}
