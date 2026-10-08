import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  LISTING_ATTRIBUTION_ROW_KEY,
  listingAttributionForcedOn,
  normalizeListingAttributionSetting,
  resolveShowListingAttribution,
  type ListingAttributionPlan,
} from "@/lib/listing-attribution";
import { getEffectiveManagerSkuTier } from "@/lib/manager-access-server";

async function readPlan(ownerUserId: string): Promise<ListingAttributionPlan> {
  try {
    const result = await getEffectiveManagerSkuTier(ownerUserId);
    return result.ok ? { ok: true, tier: result.tier } : { ok: false };
  } catch {
    return { ok: false };
  }
}

async function readSettings(db: SupabaseClient, workspaceIds: readonly string[]): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  const ids = [...new Set(workspaceIds.filter(Boolean))];
  if (ids.length === 0) return out;
  try {
    const { data, error } = await db.from("workspace_automation_settings").select("workspace_id, row_data").in("workspace_id", ids);
    if (error) return out;
    for (const row of data ?? []) {
      const rowData = (row as { row_data?: unknown }).row_data;
      const raw =
        rowData && typeof rowData === "object" && !Array.isArray(rowData)
          ? (rowData as Record<string, unknown>)[LISTING_ATTRIBUTION_ROW_KEY]
          : undefined;
      out.set(String((row as { workspace_id: string }).workspace_id), normalizeListingAttributionSetting(raw));
    }
  } catch {
    /* an unreadable setting reads as on */
  }
  return out;
}

export type ListingAttributionState = { show: boolean; setting: boolean; forced: boolean };

/** One workspace's attribution state: what the switch shows and whether the line is included. */
export async function resolveWorkspaceListingAttribution(
  db: SupabaseClient,
  ownerUserId: string,
  workspaceId: string | null,
): Promise<ListingAttributionState> {
  const plan = await readPlan(ownerUserId);
  const settings = workspaceId ? await readSettings(db, [workspaceId]) : new Map<string, boolean>();
  const setting = workspaceId ? (settings.get(workspaceId) ?? true) : true;
  const forced = listingAttributionForcedOn(plan);
  return { show: resolveShowListingAttribution({ plan, setting }), setting, forced };
}

/** Batch twin for the public catalog: `${ownerUserId}:${workspaceId ?? ""}` to show. */
export async function resolveListingAttributionByOwnerWorkspace(
  db: SupabaseClient,
  pairs: readonly { ownerUserId: string; workspaceId: string | null }[],
): Promise<Map<string, boolean>> {
  const unique = new Map<string, { ownerUserId: string; workspaceId: string | null }>();
  for (const p of pairs) {
    if (p.ownerUserId) unique.set(`${p.ownerUserId}:${p.workspaceId ?? ""}`, p);
  }
  const owners = [...new Set([...unique.values()].map((p) => p.ownerUserId))];
  const plans = new Map<string, ListingAttributionPlan>();
  await Promise.all(owners.map(async (o) => plans.set(o, await readPlan(o))));
  const settings = await readSettings(
    db,
    [...unique.values()]
      .filter((p) => p.workspaceId && !listingAttributionForcedOn(plans.get(p.ownerUserId)!))
      .map((p) => p.workspaceId!),
  );
  const out = new Map<string, boolean>();
  for (const [key, p] of unique) {
    out.set(
      key,
      resolveShowListingAttribution({
        plan: plans.get(p.ownerUserId)!,
        setting: p.workspaceId ? (settings.get(p.workspaceId) ?? true) : true,
      }),
    );
  }
  return out;
}

/** Save the workspace's choice, merging into row_data so sibling settings survive. */
export async function saveWorkspaceListingAttribution(
  db: SupabaseClient,
  workspaceId: string,
  ownerUserId: string,
  show: boolean,
): Promise<void> {
  const { data: existing, error: readError } = await db
    .from("workspace_automation_settings")
    .select("row_data")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (readError) throw readError;
  const rowData =
    existing?.row_data && typeof existing.row_data === "object" && !Array.isArray(existing.row_data)
      ? { ...(existing.row_data as Record<string, unknown>) }
      : {};
  rowData[LISTING_ATTRIBUTION_ROW_KEY] = { show };
  const { error } = await db
    .from("workspace_automation_settings")
    .upsert(
      { workspace_id: workspaceId, owner_user_id: ownerUserId, row_data: rowData, updated_at: new Date().toISOString() },
      { onConflict: "workspace_id" },
    );
  if (error) throw error;
}
