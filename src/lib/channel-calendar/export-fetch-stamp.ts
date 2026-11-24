import type { SupabaseClient } from "@supabase/supabase-js";

/** A poll is stamped at most this often per connection (production disk IO): channels poll a few times a day. */
export const EXPORT_FETCH_STAMP_THROTTLE_MS = 15 * 60_000;

/** Only the channel's own crawler counts as "Airbnb checked PropLane". */
export function isAirbnbFetcher(userAgent: string | null | undefined): boolean {
  return /airbnb/i.test(userAgent ?? "");
}

/** A browser (a manager previewing the feed) is never a channel's importer. */
function looksLikeBrowser(userAgent: string): boolean {
  return /mozilla\/.*(chrome|safari|firefox|edg)/i.test(userAgent);
}

/** "Agoda" is an Other calendar link named Agoda: the one site whose fetcher PropLane recognizes by that name. */
export function isAgodaLabel(label: string | null | undefined): boolean {
  return (label ?? "").trim().toLowerCase() === "agoda";
}

/**
 * Whether this request is the connection's OWN channel reading the feed. Airbnb and Booking.com are
 * recognised by name; Agoda's crawler User-Agent is not documented, so an Agoda link accepts its name
 * or any non-browser agent (the token is secret and per connection, a manager previews through a browser).
 */
export function isChannelFetcher(
  userAgent: string | null | undefined,
  provider: string = "airbnb",
  label?: string | null,
): boolean {
  const ua = (userAgent ?? "").trim();
  if (provider === "airbnb") return isAirbnbFetcher(ua);
  if (provider === "booking_com") return /booking/i.test(ua);
  if (provider === "ical" && isAgodaLabel(label)) return /agoda/i.test(ua) || (ua !== "" && !looksLikeBrowser(ua));
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
  const last = input.lastFetchedAt ? Date.parse(input.lastFetchedAt) : NaN;
  if (!Number.isFinite(last)) return true;
  return (input.now ?? new Date()).getTime() - last >= EXPORT_FETCH_STAMP_THROTTLE_MS;
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
