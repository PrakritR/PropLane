import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { pacificDayKey } from "@/lib/house-groups/time";
import { isMissingSchemaError } from "@/lib/one-number/config.server";
import { loadActivePolicyForWorkspace, type PolicyRow } from "@/lib/owner-management/policies.server";

/** A cart that mixes a managed workspace's charges with another workspace's cannot be allocated to one party. */
export class ManagedMixedCartError extends Error {
  constructor() {
    super("These charges belong to different payment setups. Pay them separately.");
  }
}

export type ManagedResolution = { workspaceId: string; policy: PolicyRow } | null;

/**
 * Is this set of houses a PropLane-managed workspace's? Re-read from the database every time. A house's workspace is its own
 * `workspace_id`; a house with none (legacy) is not managed. A READ that fails throws: a managed workspace's rent must never fall
 * through to a manager hold because a lookup blinked.
 */
export async function resolveManagedForProperties(
  db: SupabaseClient,
  propertyIds: ReadonlyArray<string | null | undefined>,
  paidAtIso: string,
): Promise<ManagedResolution> {
  const ids = [...new Set(propertyIds.map((id) => id?.trim() ?? ""))];
  if (ids.every((id) => !id)) return null;
  const workspaceByProperty = new Map<string, string | null>();
  const real = ids.filter(Boolean);
  const { data, error } = await db.from("manager_property_records").select("id, workspace_id").in("id", real);
  if (error) {
    if (isMissingSchemaError(error)) return null;
    throw new Error("Could not confirm which workspace this payment belongs to.");
  }
  for (const row of (data ?? []) as Array<{ id: string; workspace_id: string | null }>) {
    workspaceByProperty.set(String(row.id), row.workspace_id ? String(row.workspace_id) : null);
  }
  const day = pacificDayKey(new Date(paidAtIso));
  const resolved = new Map<string, PolicyRow | null>();
  let managed = 0;
  let plain = 0;
  let workspaceId = "";
  let policy: PolicyRow | null = null;
  for (const id of ids) {
    const ws = id ? workspaceByProperty.get(id) ?? null : null;
    if (!ws) {
      plain += 1;
      continue;
    }
    if (!resolved.has(ws)) resolved.set(ws, await loadActivePolicyForWorkspace(db, ws, day));
    const p = resolved.get(ws)!;
    if (p) {
      if (workspaceId && workspaceId !== ws) throw new ManagedMixedCartError();
      workspaceId = ws;
      policy = p;
      managed += 1;
    } else {
      plain += 1;
    }
  }
  if (managed === 0) return null;
  if (plain > 0) throw new ManagedMixedCartError();
  return { workspaceId, policy: policy! };
}

/** The checkout-time guard: refuse a cart that would be half managed. Returns an error message or null. */
export async function managedCartProblem(
  db: SupabaseClient,
  propertyIds: ReadonlyArray<string | null | undefined>,
  now: Date = new Date(),
): Promise<string | null> {
  try {
    await resolveManagedForProperties(db, propertyIds, now.toISOString());
    return null;
  } catch (e) {
    if (e instanceof ManagedMixedCartError) return e.message;
    return "Could not confirm where this payment goes. Try again in a moment.";
  }
}
