import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { SharedLineConfig } from "@/lib/one-number/contracts";
import { normalizeE164 } from "@/lib/phone-e164";

/**
 * The shared PropLane number as outbound transport sees it: read from
 * `sms_runtime_config` (`line_mode`, `shared_number_e164`,
 * `shared_messaging_service_sid`, `shared_pilot_workspace_ids`).
 *
 * Flag safety: every read here is TOLERANT. Production runs code before its
 * migrations, so a missing table/column (42P01, 42703, PGRST204/205) or any
 * other read trouble answers "per_workspace", which keeps the product behaving
 * exactly as it does today. Nothing in this file ever throws.
 */

const MISSING_SCHEMA_CODES = new Set(["42P01", "42703", "PGRST204", "PGRST205"]);

/** Postgres/PostgREST "that table or column is not there yet". */
export function isMissingSchemaError(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!error) return false;
  return MISSING_SCHEMA_CODES.has(String(error.code ?? ""));
}

export const PER_WORKSPACE_CONFIG: SharedLineConfig = {
  mode: "per_workspace",
  sharedNumber: null,
  messagingServiceSid: null,
  pilotWorkspaceIds: [],
};

/** Read the line mode + shared number. Any error or odd value reads as `per_workspace`. */
export async function readSharedLineConfig(db: SupabaseClient): Promise<SharedLineConfig> {
  try {
    const { data, error } = await db
      .from("sms_runtime_config")
      .select("line_mode, shared_number_e164, shared_messaging_service_sid, shared_pilot_workspace_ids")
      .eq("singleton", true)
      .maybeSingle();
    if (error || !data) return PER_WORKSPACE_CONFIG;
    const row = data as Record<string, unknown>;
    const mode = row.line_mode === "shared" || row.line_mode === "shadow" ? row.line_mode : "per_workspace";
    const number = typeof row.shared_number_e164 === "string" ? normalizeE164(row.shared_number_e164) : null;
    const sid = typeof row.shared_messaging_service_sid === "string" ? row.shared_messaging_service_sid.trim() : "";
    const pilot = Array.isArray(row.shared_pilot_workspace_ids)
      ? (row.shared_pilot_workspace_ids as unknown[]).map((id) => String(id).trim()).filter(Boolean)
      : [];
    return { mode, sharedNumber: number, messagingServiceSid: sid || null, pilotWorkspaceIds: pilot };
  } catch {
    return PER_WORKSPACE_CONFIG;
  }
}

/**
 * True when texts for `workspaceId` leave from the shared number: mode is
 * `shared`, the number is attached, and the workspace is in the pilot (an empty
 * pilot list means every workspace). `shadow` never sends from the shared line.
 */
export function sharedLineActiveFor(config: SharedLineConfig, workspaceId: string | null | undefined): boolean {
  if (config.mode !== "shared" || !config.sharedNumber) return false;
  const id = String(workspaceId ?? "").trim();
  if (!id) return false;
  return config.pilotWorkspaceIds.length === 0 || config.pilotWorkspaceIds.includes(id);
}

/** True when `phone` is the configured shared number (any mode that has one attached). */
export async function isConfiguredSharedNumber(db: SupabaseClient, phone: string): Promise<boolean> {
  const normalized = normalizeE164(phone);
  if (!normalized) return false;
  const config = await readSharedLineConfig(db);
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
    const config = await readSharedLineConfig(db);
    if (config.mode !== "shared") return null;
    const workspaceId = await resolveSendWorkspaceId(db, args.ownerUserId, {
      workspaceId: args.selectedWorkLineId ?? null,
      propertyId: args.propertyId ?? null,
    }) ?? await resolveSendWorkspaceId(db, args.ownerUserId, { propertyId: args.propertyId ?? null });
    if (!workspaceId || !sharedLineActiveFor(config, workspaceId)) return null;

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
