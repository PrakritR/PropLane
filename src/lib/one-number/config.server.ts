import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { SharedLineConfig, SharedLineMode } from "@/lib/one-number/contracts";
import { normalizeE164 } from "@/lib/phone-e164";

/** The state every caller gets when the line is off or unreadable: today's per-workspace numbers. */
export const PER_WORKSPACE_CONFIG: SharedLineConfig = {
  mode: "per_workspace",
  sharedNumber: null,
  messagingServiceSid: null,
  pilotWorkspaceIds: [],
};

const MODES: readonly SharedLineMode[] = ["per_workspace", "shadow", "shared"];

/** Postgres 42P01 / 42703 and PostgREST PGRST205 / PGRST204: the migration has not run here yet. */
export function isMissingSchemaError(error: { code?: string | null } | null | undefined): boolean {
  const code = String(error?.code ?? "");
  return code === "42P01" || code === "42703" || code === "PGRST205" || code === "PGRST204";
}

/**
 * Read the line mode from `sms_runtime_config`. Fails CLOSED to `per_workspace`
 * on any read error, a missing column (code runs before the migration), an
 * unknown mode, or a shared mode with no usable shared number.
 */
export async function loadSharedLineConfig(db: SupabaseClient): Promise<SharedLineConfig> {
  try {
    const { data, error } = await db
      .from("sms_runtime_config")
      .select("line_mode, shared_number_e164, shared_messaging_service_sid, shared_pilot_workspace_ids")
      .eq("singleton", true)
      .maybeSingle();
    if (error || !data) return PER_WORKSPACE_CONFIG;
    const row = data as Record<string, unknown>;
    const mode = MODES.find((m) => m === row.line_mode) ?? "per_workspace";
    const sharedNumber = normalizeE164(row.shared_number_e164);
    // Shadow only compares decisions and needs no number; a live shared line cannot exist without one.
    if (mode === "shared" && !sharedNumber) return PER_WORKSPACE_CONFIG;
    const sid = typeof row.shared_messaging_service_sid === "string" ? row.shared_messaging_service_sid.trim() : "";
    const pilot = Array.isArray(row.shared_pilot_workspace_ids)
      ? row.shared_pilot_workspace_ids.map((id) => String(id ?? "").trim()).filter(Boolean)
      : [];
    return { mode, sharedNumber, messagingServiceSid: sid || null, pilotWorkspaceIds: pilot };
  } catch {
    return PER_WORKSPACE_CONFIG;
  }
}

/** Is `toPhone` (any format) the PropLane shared number? Always false in per_workspace mode. */
export function isSharedLineNumber(config: SharedLineConfig, toPhone: string | null | undefined): boolean {
  if (config.mode === "per_workspace" || !config.sharedNumber) return false;
  const to = normalizeE164(toPhone);
  return Boolean(to) && to === config.sharedNumber;
}

/** Does this workspace answer on the shared line? Mode shared, and (no pilot list, or it is on the list). */
export function workspaceOnSharedLine(config: SharedLineConfig, workspaceId: string | null | undefined): boolean {
  if (config.mode !== "shared" || !config.sharedNumber) return false;
  const id = String(workspaceId ?? "").trim();
  if (!id) return false;
  return config.pilotWorkspaceIds.length === 0 || config.pilotWorkspaceIds.includes(id);
}
