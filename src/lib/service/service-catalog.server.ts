import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { MockProperty } from "@/data/types";
import { getPublicListings } from "@/lib/public-listings.server";
import { createTtlCache, serverSnapshotCacheEnabled } from "@/lib/server-ttl-cache";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { normalizeE164 } from "@/lib/phone-e164";

/**
 * The catalog behind the PropLane line: the live homes of the PropLane-managed (`is_service`) workspaces and nothing else.
 *
 * "The PropLane line" is the shared number in `shared` mode, and in `per_workspace` mode (where production runs today)
 * every active number the platform service owner holds. A prospect texting it is shown homes PropLane manages, drawn from
 * `getPublicListings` (the allowlisted public projection, never a raw row). A prospect texting any other workspace's own number
 * keeps today's behaviour: that workspace's homes only.
 */

const CACHE_MS = 60_000;
const idsCache = createTtlCache<string[]>(CACHE_MS);
const listingsCache = createTtlCache<MockProperty[]>(CACHE_MS);

/** Ids of every workspace carrying `is_service`. Throws when the read fails: the caller says "the team will follow up", it never widens. */
export async function loadServiceWorkspaceIds(db: SupabaseClient = createSupabaseServiceRoleClient()): Promise<string[]> {
  const load = async () => {
    const { data, error } = await db.from("portal_workspaces").select("id").eq("is_service", true).limit(500);
    if (error) throw new Error("service workspaces unreadable");
    return ((data ?? []) as { id?: unknown }[]).map((row) => String(row.id ?? "").trim()).filter(Boolean);
  };
  return serverSnapshotCacheEnabled() ? idsCache.get("ids", load) : load();
}

/** Live public listings of the PropLane-managed workspaces. Throws on a failed read (never falls back to the whole catalog). */
export async function getServicePublicListings(db?: SupabaseClient): Promise<MockProperty[]> {
  const load = async () => {
    const ids = await loadServiceWorkspaceIds(db);
    return getPublicListings({ workspaceIds: ids });
  };
  return serverSnapshotCacheEnabled() ? listingsCache.get("listings", load) : load();
}

/** Tests only. */
export function resetServiceCatalogCache(): void {
  idsCache.clear();
  listingsCache.clear();
}

type OwnerCache = { value: string | null; at: number };
let ownerCache: OwnerCache | null = null;

/** The platform service owner's user id, or null (no row, migration absent, or unreadable). Cached for a minute. */
export async function readPlatformServiceOwnerId(db: SupabaseClient): Promise<string | null> {
  if (serverSnapshotCacheEnabled() && ownerCache && Date.now() - ownerCache.at < CACHE_MS) return ownerCache.value;
  const { data, error } = await db.from("platform_service_settings").select("owner_user_id").eq("singleton", true).maybeSingle();
  const value = error ? null : String((data as { owner_user_id?: unknown } | null)?.owner_user_id ?? "").trim() || null;
  if (!error && serverSnapshotCacheEnabled()) ownerCache = { value, at: Date.now() };
  return value;
}

/**
 * The same read that THROWS when it cannot be made. A gate that decides whether a security control applies (the
 * dispatch approval code) must tell "no service owner" from "could not read", which `readPlatformServiceOwnerId` folds
 * into one null. Not cached: a failure must never be remembered as an answer.
 */
export async function readPlatformServiceOwnerIdOrThrow(db: SupabaseClient): Promise<string | null> {
  const { data, error } = await db.from("platform_service_settings").select("owner_user_id").eq("singleton", true).maybeSingle();
  if (error) throw new Error(error.message || "platform service owner read failed");
  return String((data as { owner_user_id?: unknown } | null)?.owner_user_id ?? "").trim() || null;
}

export function resetPlatformServiceOwnerCache(): void {
  ownerCache = null;
}

/**
 * Is a text to `workNumber`, answered as `ownerUserId`, a text to the PropLane line in per-workspace mode? True when the
 * number belongs to the platform service owner (the account that owns the PropLane Service) and is not released. In
 * `shared` mode the line is the configured shared number and strangers are served by the router, so this stays false for
 * the shared number itself. Anything unreadable is false: the text is then answered exactly as before.
 */
export async function isPropLaneServiceLine(
  db: SupabaseClient,
  input: {
    ownerUserId: string;
    workNumber: string | null | undefined;
    sharedNumber?: string | null;
    /**
     * What to answer when the answer cannot be READ (a failed platform-owner or number read). Omitted = false, which is right
     * for routing. A security gate that must not switch off on a database error passes `true`.
     */
    onUnreadable?: boolean;
  },
): Promise<boolean> {
  const owner = input.ownerUserId.trim();
  const number = normalizeE164(input.workNumber ?? "");
  if (!owner || !number) return false;
  const shared = normalizeE164(input.sharedNumber ?? "");
  if (shared && shared === number) return false;
  try {
    const serviceOwner = input.onUnreadable === undefined ? await readPlatformServiceOwnerId(db) : await readPlatformServiceOwnerIdOrThrow(db);
    if (!serviceOwner || serviceOwner !== owner) return false;
    const { data, error } = await db
      .from("manager_sms_numbers")
      .select("id, phone_number, provision_state, released_at")
      .eq("manager_user_id", owner)
      .is("released_at", null);
    if (error) return input.onUnreadable ?? false;
    return ((data ?? []) as { phone_number?: unknown; provision_state?: unknown }[]).some(
      (row) => normalizeE164(String(row.phone_number ?? "")) === number && String(row.provision_state ?? "") !== "failed",
    );
  } catch {
    return input.onUnreadable ?? false;
  }
}
