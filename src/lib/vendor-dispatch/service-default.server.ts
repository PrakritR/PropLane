import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingSchemaError } from "@/lib/one-number/config.server";
import { createTtlCache, serverSnapshotCacheEnabled } from "@/lib/server-ttl-cache";
import { normalizeVendorDispatchSettings, type VendorDispatchSettings } from "@/lib/vendor-dispatch-settings";

/** The same window the service-roster lookups use, for the same reason: one sweep, one read per workspace. */
const LOOKUP_TTL_MS = 30_000;

/**
 * A PropLane Service workspace dispatches by default: a filed repair becomes a dispatch run that waits for the manager's (or the
 * service manager's) Y, with the workspace roster as the chain. A manager who SAVED a dispatch mode keeps it, "off" included.
 * A self-serve workspace keeps "off" until set. docs/agents/vendor-dispatch-agent.md § Defaults.
 */
export async function isServiceWorkspace(db: SupabaseClient, workspaceId: string | null | undefined): Promise<boolean> {
  const id = workspaceId?.trim() ?? "";
  if (!id) return false;
  const { data, error } = await db.from("portal_workspaces").select("is_service").eq("id", id).maybeSingle();
  if (error) {
    if (isMissingSchemaError(error)) return false;
    return false;
  }
  return (data as { is_service?: boolean | null } | null)?.is_service === true;
}

export type DispatchSettingsResolution = {
  settings: VendorDispatchSettings;
  explicit: boolean;
  serviceDefault: boolean;
  /**
   * The saved settings could not be READ (a failed `manager_automation_settings` query), so `settings` is the
   * default rather than this workspace's answer. A gate that must not let a run through on a workspace whose saved
   * mode might be "off" refuses on this; a caller that only needs a usable default may ignore it.
   */
  unreadable?: boolean;
};

const settingsCache = createTtlCache<DispatchSettingsResolution>(LOOKUP_TTL_MS);

/**
 * The settings to act on for one workspace: the saved ones, else (service workspace) mode `approve` (propose,
 * one-tap Y).
 *
 * Memoized per (manager, workspace) for `LOOKUP_TTL_MS`: the turnover sweep asks this once per stay through
 * `workspaceHasMatchingRule`, beside a roster lookup that is cached for exactly that reason
 * (AGENTS.md § Performance & egress). A failed read is never cached.
 */
export async function resolveDispatchSettings(
  db: SupabaseClient,
  managerUserId: string,
  workspaceId: string | null | undefined,
): Promise<DispatchSettingsResolution> {
  const load = () => loadDispatchSettings(db, managerUserId, workspaceId);
  if (!serverSnapshotCacheEnabled()) return load();
  const resolution = await settingsCache.get(`${managerUserId}::${workspaceId ?? ""}`, load);
  // A snapshot must not remember "I could not read it": the next caller asks again.
  if (resolution.unreadable) settingsCache.clear();
  return resolution;
}

async function loadDispatchSettings(
  db: SupabaseClient,
  managerUserId: string,
  workspaceId: string | null | undefined,
): Promise<DispatchSettingsResolution> {
  const { data, error } = await db.from("manager_automation_settings").select("vendor_dispatch").eq("manager_user_id", managerUserId).maybeSingle();
  const raw = (data as { vendor_dispatch?: unknown } | null)?.vendor_dispatch ?? null;
  const settings = normalizeVendorDispatchSettings(raw);
  // A failed read and "no row saved" both arrive as no `vendor_dispatch`, and they are not the same answer: the
  // first cannot tell whether this workspace saved "off".
  const unreadable = Boolean(error) && !isMissingSchemaError(error);
  const mode = raw && typeof raw === "object" ? (raw as { mode?: unknown }).mode : undefined;
  const explicit = mode === "off" || mode === "approve" || mode === "auto";
  if (explicit || settings.mode !== "off") return { settings, explicit, serviceDefault: false, ...(unreadable ? { unreadable } : {}) };
  if (!unreadable && (await isServiceWorkspace(db, workspaceId))) {
    return { settings: { ...settings, mode: "approve" }, explicit: false, serviceDefault: true };
  }
  return { settings, explicit, serviceDefault: false, ...(unreadable ? { unreadable } : {}) };
}

/** Tests only. */
export function resetDispatchSettingsCache(): void {
  settingsCache.clear();
}

export const DISPATCH_KEYWORD = /^\s*dispatch\s*[.!]?\s*$/i;
export function isDispatchKeyword(body: string): boolean {
  return DISPATCH_KEYWORD.test(String(body ?? ""));
}
