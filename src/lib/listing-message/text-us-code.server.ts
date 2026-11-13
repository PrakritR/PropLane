import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createEntryCode, listEntryCodes } from "@/lib/one-number/entry-codes.server";
import { loadMessageListing } from "./listing.server";

/**
 * The entry code the listing's "Text us" body ends with: the home's active `sms_entry_codes` row, created once, lazily,
 * when the home has none (a code the manager already holds is always preferred). It names a workspace and a house, never
 * a person. Null for anything that is not a live public listing, or when a code cannot be had: the button then simply
 * sends the words without a code.
 */
export async function resolveListingTextUsCode(db: SupabaseClient, propertyId: string): Promise<string | null> {
  const loaded = await loadMessageListing(db, { propertyId, roomId: null });
  if (!loaded.ok) return null;
  const { listing } = loaded;
  const active = (await listEntryCodes(db, { workspaceId: listing.workspaceId, propertyId: listing.propertyId })).filter((c) => c.active);
  if (active[0]) return active[0].code;
  const created = await createEntryCode(db, {
    workspaceId: listing.workspaceId,
    ownerUserId: listing.ownerUserId,
    actorUserId: listing.ownerUserId,
    propertyId: listing.propertyId,
  }).catch(() => null);
  return created && created.ok ? created.record.code : null;
}
