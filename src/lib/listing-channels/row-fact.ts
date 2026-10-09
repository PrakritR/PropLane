import { listingHoldFact, type ListingHoldReason } from "@/lib/listing-channels/post-text";
import type { ListingChannelPostRow } from "@/lib/listing-channels/registry";

export function shortDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Los_Angeles" });
}

const ERROR_COPY: Record<string, string> = {
  "Reconnect Facebook.": "Reconnect Facebook",
};

/**
 * The one plain fact a listing-site row shows for an automatic channel on one listing.
 * Never a status chip: "Posted Oct 6", "Held: no photo", "Set up work number", "Off".
 */
export function automaticChannelFact(args: {
  row: ListingChannelPostRow | null;
  holdReasons: readonly ListingHoldReason[];
  listingLive: boolean;
}): string {
  const { row, holdReasons, listingLive } = args;
  // A hand-post marker outranks every automatic fact: the queue leaves such a row alone.
  if (row?.state === "posted_by_me") {
    const when = shortDate(row.postedAt ?? row.updatedAt);
    return when ? `Posted by you · ${when}` : "Posted by you";
  }
  const enabled = row ? row.enabled : true;
  if (!enabled) return "Off";
  if (holdReasons.length > 0 && row?.state !== "posted") return listingHoldFact(holdReasons);
  if (!row) return listingLive ? "Posts when saved" : "Posts when live";
  if (row.state === "posted") return row.postedAt ? `Posted ${shortDate(row.postedAt)}` : "Posted";
  if (row.state === "pending" || row.state === "posting") return "Posting soon";
  if (row.state === "failed") return ERROR_COPY[row.lastError ?? ""] ?? (row.lastError ? `Failed: ${row.lastError.slice(0, 60)}` : "Failed");
  if (row.state === "held") return listingHoldFact((row.lastError?.split(",") as ListingHoldReason[] | undefined) ?? holdReasons);
  return listingLive ? "Posts when saved" : "Posts when live";
}
