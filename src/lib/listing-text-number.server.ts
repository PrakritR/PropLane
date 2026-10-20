import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { getPublicTextingConfig } from "@/lib/marketing/public-texting.server";
import { resolveActiveManagerSendNumber } from "@/lib/sms/manager-number-provisioning.server";

/**
 * The ONE answer to "which number does the public listing page tell a prospect to text".
 *
 * - A listing on a PropLane-managed workspace (`portal_workspaces.is_service`) texts the PropLane line.
 * - A listing on a software customer's own workspace texts that workspace's own active work number; a
 *   workspace with none texts the PropLane line.
 *
 * The PropLane line is what the public pages already use (`getPublicTextingConfig`). The single-listing
 * route and the catalog both resolve through here, so Browse and a share link can never disagree.
 *
 * Fail-safe: a failed `is_service` read is treated as NOT managed (own number, else the PropLane line),
 * never as managed, so one hiccup cannot hide a customer's own number behind the shared line.
 */
export type ListingTextNumberTarget = { ownerUserId: string; workspaceId?: string | null };

export function listingTextNumberKey(target: ListingTextNumberTarget): string {
  return `${target.ownerUserId}:${target.workspaceId ?? ""}`;
}

async function readManagedWorkspaceIds(db: SupabaseClient, workspaceIds: readonly string[]): Promise<Set<string>> {
  const managed = new Set<string>();
  if (workspaceIds.length === 0) return managed;
  try {
    const { data, error } = await db.from("portal_workspaces").select("id, is_service").in("id", [...workspaceIds]);
    if (error) return managed;
    for (const row of (data ?? []) as Array<{ id?: unknown; is_service?: unknown }>) {
      if (row.is_service === true && typeof row.id === "string") managed.add(row.id);
    }
  } catch {
    // Fail-safe: not managed.
  }
  return managed;
}

/** Batched form for the catalog: one `portal_workspaces` read for every workspace id, keyed by {@link listingTextNumberKey}. */
export async function resolveListingTextNumbers(
  db: SupabaseClient,
  targets: readonly ListingTextNumberTarget[],
): Promise<Map<string, string | null>> {
  const unique = new Map<string, ListingTextNumberTarget>();
  for (const target of targets) {
    if (target.ownerUserId) unique.set(listingTextNumberKey(target), target);
  }
  const workspaceIds = [
    ...new Set([...unique.values()].map((t) => t.workspaceId).filter((id): id is string => typeof id === "string" && id.length > 0)),
  ];
  const managed = await readManagedWorkspaceIds(db, workspaceIds);

  // The PropLane line is read lazily and once: a catalog of self-serve houses that all hold their own number never needs it.
  let propLane: Promise<string | null> | null = null;
  const propLaneLine = () =>
    (propLane ??= getPublicTextingConfig().then((config) => config.phone ?? null).catch(() => null));

  const out = new Map<string, string | null>();
  await Promise.all(
    [...unique.entries()].map(async ([key, target]) => {
      const workspaceId = target.workspaceId ?? null;
      if (workspaceId && managed.has(workspaceId)) {
        out.set(key, await propLaneLine());
        return;
      }
      const own = await resolveActiveManagerSendNumber(db, target.ownerUserId, workspaceId).catch(() => null);
      out.set(key, own ?? (await propLaneLine()));
    }),
  );
  return out;
}

export async function resolveListingTextNumber(db: SupabaseClient, target: ListingTextNumberTarget): Promise<string | null> {
  const map = await resolveListingTextNumbers(db, [target]);
  return map.get(listingTextNumberKey(target)) ?? null;
}
