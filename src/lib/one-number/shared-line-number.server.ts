import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadSharedLineConfig, workspaceOnSharedLine } from "@/lib/one-number/config.server";
import { normalizeE164 } from "@/lib/phone-e164";

/**
 * Transport-side helpers for the shared number. The config reader, the
 * missing-schema check and the "is this workspace on the shared line" decision
 * live ONLY in `config.server.ts` (fail closed to per_workspace); they are
 * re-exported here for the transport callers that already import this module.
 */
export { PER_WORKSPACE_CONFIG, isMissingSchemaError, loadSharedLineConfig, workspaceOnSharedLine } from "@/lib/one-number/config.server";

/** True when `phone` is the configured shared number (any mode that has one attached). */
export async function isConfiguredSharedNumber(db: SupabaseClient, phone: string): Promise<boolean> {
  const normalized = normalizeE164(phone);
  if (!normalized) return false;
  const config = await loadSharedLineConfig(db);
  return config.sharedNumber !== null && config.sharedNumber === normalized;
}

/**
 * The workspace a send is about: the one named, else the workspace that holds
 * the house, else the owner's default workspace. Null when none can be proven.
 */
export async function resolveSendWorkspaceId(
  db: SupabaseClient,
  ownerUserId: string,
  opts: { workspaceId?: string | null; propertyId?: string | null },
): Promise<string | null> {
  const named = String(opts.workspaceId ?? "").trim();
  try {
    if (named) {
      const { data } = await db
        .from("portal_workspaces")
        .select("id")
        .eq("id", named)
        .eq("owner_user_id", ownerUserId)
        .maybeSingle();
      return data?.id ? String(data.id) : null;
    }
    const propertyId = String(opts.propertyId ?? "").trim();
    if (propertyId) {
      const { data: house } = await db
        .from("manager_property_records")
        .select("workspace_id")
        .eq("id", propertyId)
        .maybeSingle();
      const fromHouse = String(house?.workspace_id ?? "").trim();
      if (fromHouse) return fromHouse;
    }
    const { data: def } = await db
      .from("portal_workspaces")
      .select("id")
      .eq("owner_user_id", ownerUserId)
      .eq("is_default", true)
      .maybeSingle();
    return def?.id ? String(def.id) : null;
  } catch {
    return null;
  }
}

/** "5259 Brooklyn team" - the short sign-off a human reply carries on the shared line. */
export function buildSharedLineSignOff(label: string | null | undefined): string | null {
  const name = String(label ?? "").trim().replace(/\s+/g, " ");
  if (!name) return null;
  return `${name.slice(0, 40)} team`;
}

/**
 * Is a human send from the inbox leaving on the shared line? Answers with the
 * workspace that pays and the sign-off ("<house or workspace name> team"), or
 * null when the line is per-workspace (nothing changes: no sign-off, no stamp).
 *
 * `selectedWorkLineId` is a projection thread's line; on the shared line that id
 * IS the workspace id, so it names the workspace directly.
 */
export async function resolveSharedLineHumanSend(
  db: SupabaseClient,
  args: { ownerUserId: string; selectedWorkLineId?: string | null; propertyId?: string | null },
): Promise<{ workspaceId: string; signOff: string | null } | null> {
  try {
    const config = await loadSharedLineConfig(db);
    if (config.mode !== "shared") return null;
    const workspaceId = await resolveSendWorkspaceId(db, args.ownerUserId, {
      workspaceId: args.selectedWorkLineId ?? null,
      propertyId: args.propertyId ?? null,
    }) ?? await resolveSendWorkspaceId(db, args.ownerUserId, { propertyId: args.propertyId ?? null });
    if (!workspaceId || !workspaceOnSharedLine(config, workspaceId)) return null;

    let label: string | null = null;
    const propertyId = String(args.propertyId ?? "").trim();
    if (propertyId) {
      const { data: house } = await db
        .from("manager_property_records")
        .select("id, property_data, row_data")
        .eq("id", propertyId)
        .maybeSingle();
      if (house) {
        const { labelFromManagerPropertyRecordRow } = await import("@/lib/co-manager-property-label");
        const houseLabel = labelFromManagerPropertyRecordRow(house as { id?: string; property_data?: unknown; row_data?: unknown });
        // The record id is the label's last resort; a sign-off never prints an id.
        if (houseLabel && houseLabel !== String(house.id ?? "")) label = houseLabel.split(" · ")[0];
      }
    }
    if (!label) {
      const { data: workspace } = await db.from("portal_workspaces").select("name").eq("id", workspaceId).maybeSingle();
      label = String(workspace?.name ?? "").trim() || null;
    }
    return { workspaceId, signOff: buildSharedLineSignOff(label) };
  } catch {
    return null;
  }
}
