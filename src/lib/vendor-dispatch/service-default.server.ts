import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingSchemaError } from "@/lib/one-number/config.server";
import { normalizeVendorDispatchSettings, type VendorDispatchSettings } from "@/lib/vendor-dispatch-settings";

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

export type DispatchSettingsResolution = { settings: VendorDispatchSettings; explicit: boolean; serviceDefault: boolean };

/** The settings to act on for one workspace: the saved ones, else (service workspace) mode `approve` (propose, one-tap Y). */
export async function resolveDispatchSettings(
  db: SupabaseClient,
  managerUserId: string,
  workspaceId: string | null | undefined,
): Promise<DispatchSettingsResolution> {
  const { data } = await db.from("manager_automation_settings").select("vendor_dispatch").eq("manager_user_id", managerUserId).maybeSingle();
  const raw = (data as { vendor_dispatch?: unknown } | null)?.vendor_dispatch ?? null;
  const settings = normalizeVendorDispatchSettings(raw);
  const mode = raw && typeof raw === "object" ? (raw as { mode?: unknown }).mode : undefined;
  const explicit = mode === "off" || mode === "approve" || mode === "auto";
  if (explicit || settings.mode !== "off") return { settings, explicit, serviceDefault: false };
  if (await isServiceWorkspace(db, workspaceId)) {
    return { settings: { ...settings, mode: "approve" }, explicit: false, serviceDefault: true };
  }
  return { settings, explicit, serviceDefault: false };
}

export const DISPATCH_KEYWORD = /^\s*dispatch\s*[.!]?\s*$/i;
export function isDispatchKeyword(body: string): boolean {
  return DISPATCH_KEYWORD.test(String(body ?? ""));
}
