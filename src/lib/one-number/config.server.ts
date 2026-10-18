import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { SharedLineConfig, SharedLineMode } from "@/lib/one-number/contracts";
import { normalizeE164 } from "@/lib/phone-e164";
import { managerCanSendFromOwnNumber, normalizeProvisionState, normalizeRegistrationState } from "@/lib/sms/number-registration-policy";

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
    // Which workspaces hold their own number only matters while the shared line is live.
    if (mode !== "shared") return { mode, sharedNumber, messagingServiceSid: sid || null, pilotWorkspaceIds: pilot };
    const dedicated = await loadDedicatedWorkspaceIds(db);
    // Unknown which workspaces hold their own number: stay on today's per-workspace lines.
    if (dedicated === null) return PER_WORKSPACE_CONFIG;
    return { mode, sharedNumber, messagingServiceSid: sid || null, pilotWorkspaceIds: pilot, dedicatedWorkspaceIds: dedicated };
  } catch {
    return PER_WORKSPACE_CONFIG;
  }
}

/**
 * A number that can carry a workspace's traffic: live, with a phone number and an approved registration
 * (`managerCanSendFromOwnNumber`, the same test the send path and the "show the number" resolver use).
 * A number still being provisioned, awaiting registration, failed or released does NOT take a workspace
 * off the PropLane line: until the personal number works, the workspace keeps texting on the line.
 */
function usableNumber(row: Record<string, unknown>): boolean {
  if (row.released_at) return false;
  return managerCanSendFromOwnNumber({
    provisionState: normalizeProvisionState(typeof row.provision_state === "string" ? row.provision_state : null),
    phoneNumber: typeof row.phone_number === "string" ? row.phone_number : null,
    registrationState: normalizeRegistrationState(typeof row.registration_state === "string" ? row.registration_state : null),
    registrationRef: typeof row.registration_ref === "string" ? row.registration_ref : null,
  });
}

/**
 * Workspaces holding a working work number of their own that its owner PAYS for: the number's home
 * workspace, plus any workspace linked to it through `workspace_work_numbers`. Null when it (or an
 * owner's entitlement) cannot be read.
 */
async function loadDedicatedWorkspaceIds(db: SupabaseClient): Promise<string[] | null> {
  const numbers = await db
    .from("manager_sms_numbers")
    .select("id, manager_user_id, workspace_id, phone_number, provision_state, registration_state, registration_ref, released_at")
    .not("workspace_id", "is", null);
  if (numbers.error) return isMissingSchemaError(numbers.error) ? [] : null;
  const working = (Array.isArray(numbers.data) ? numbers.data : []).filter((row) => usableNumber(row as Record<string, unknown>));
  // Dedicated = a working number AND a paid personalized-number entitlement on its owner (a Pro or
  // Business plan, or the standalone PropLane Number add-on). A number nobody pays for does not take a
  // workspace off the PropLane line. An entitlement that cannot be read fails the whole read closed.
  const owners = [...new Set(working.map((row) => String((row as { manager_user_id?: unknown }).manager_user_id ?? "").trim()).filter(Boolean))];
  const paid = new Set<string>();
  if (owners.length > 0) {
    const { managerPersonalNumberEntitlement } = await import("@/lib/one-number/personal-number-entitlement.server");
    for (const owner of owners) {
      const entitlement = await managerPersonalNumberEntitlement(db, owner);
      if (!entitlement.ok) return null;
      if (entitlement.entitled) paid.add(owner);
    }
  }
  const usable = working.filter((row) => paid.has(String((row as { manager_user_id?: unknown }).manager_user_id ?? "").trim()));
  const ids = new Set(usable.map((row) => String((row as { workspace_id?: unknown }).workspace_id ?? "").trim()).filter(Boolean));
  const usableNumberIds = usable.map((row) => String((row as { id?: unknown }).id ?? "")).filter(Boolean);
  if (usableNumberIds.length > 0) {
    const links = await db.from("workspace_work_numbers").select("workspace_id").in("number_id", usableNumberIds);
    if (links.error && !isMissingSchemaError(links.error)) return null;
    for (const link of links.data ?? []) {
      const id = String((link as { workspace_id?: unknown }).workspace_id ?? "").trim();
      if (id) ids.add(id);
    }
  }
  return [...ids];
}

/** Is `toPhone` (any format) the PropLane shared number? Always false in per_workspace mode. */
export function isSharedLineNumber(config: SharedLineConfig, toPhone: string | null | undefined): boolean {
  if (config.mode === "per_workspace" || !config.sharedNumber) return false;
  const to = normalizeE164(toPhone);
  return Boolean(to) && to === config.sharedNumber;
}

/**
 * Does this workspace answer on the shared line? Mode shared, the workspace holds no number of its
 * own, and (no pilot list, or it is on the list).
 */
export function workspaceOnSharedLine(config: SharedLineConfig, workspaceId: string | null | undefined): boolean {
  if (config.mode !== "shared" || !config.sharedNumber) return false;
  const id = String(workspaceId ?? "").trim();
  if (!id) return false;
  if (config.dedicatedWorkspaceIds?.includes(id)) return false;
  return config.pilotWorkspaceIds.length === 0 || config.pilotWorkspaceIds.includes(id);
}

/** Does this workspace text from a number of its own (Pro / Business personalized line, or the PropLane service line)? */
export function workspaceHasDedicatedNumber(config: SharedLineConfig, workspaceId: string | null | undefined): boolean {
  const id = String(workspaceId ?? "").trim();
  return Boolean(id) && Boolean(config.dedicatedWorkspaceIds?.includes(id));
}
