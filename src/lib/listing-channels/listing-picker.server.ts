import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

import { listingPickerSourceFromProperty, type ListingPickerSource } from "@/lib/listing-channels/listing-picker";
import { asProperty, publicListingProjection } from "@/lib/public-listings.server";

/** `.in(...)` becomes a query string, so the workspace's listings are read in slices. */
const ID_CHUNK = 100;

/**
 * Every listing in the workspace, as the picker needs it (name, rooms, status, hold reasons), built
 * from `publicListingProjection` like every other Listing sites read. `propertyIds` must come from the
 * authenticated workspace (`workspace.propertyIds`), never from the request. A row whose stored JSON
 * is malformed is left out rather than guessed at.
 */
export async function loadListingPickerSources(
  db: SupabaseClient,
  args: { workspaceId: string; propertyIds: readonly string[]; workNumberSet: boolean },
): Promise<ListingPickerSource[]> {
  const out: ListingPickerSource[] = [];
  for (let i = 0; i < args.propertyIds.length; i += ID_CHUNK) {
    const slice = args.propertyIds.slice(i, i + ID_CHUNK);
    const { data, error } = await db
      .from("manager_property_records")
      .select("id, status, property_data")
      .eq("workspace_id", args.workspaceId)
      .in("id", slice);
    if (error || !data) continue;
    for (const row of data as { id: unknown; status: unknown; property_data: unknown }[]) {
      const property = asProperty(row.property_data, String(row.id));
      if (!property) continue;
      out.push(
        listingPickerSourceFromProperty(publicListingProjection(property), {
          status: typeof row.status === "string" ? row.status : "",
          workNumberSet: args.workNumberSet,
        }),
      );
    }
  }
  return out;
}
