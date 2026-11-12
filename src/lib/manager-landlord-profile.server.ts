import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  loadManagerLandlordProfile,
  loadManagerLandlordLegalNameFromProfile,
  normalizeManagerLandlordProfile,
  pickLandlordLegalName,
  saveManagerLandlordProfile,
  type LandlordNameSource,
  type ManagerLandlordProfile,
} from "@/lib/manager-landlord-profile";
import {
  createSettingsScopeCache,
  resolveSettingsScope,
  saveWorkspaceNamespaceSettings,
  type SettingsScopeCache,
} from "@/lib/settings/scope-resolver.server";

/**
 * "Landlord on leases" is chosen once per WORKSPACE (the settings copy, and the staff seat that may change
 * it, both say so), so it is stored on the workspace rung — `workspace_automation_settings.row_data.landlordProfile`
 * — not on the owner's account row, where an owner running two workspaces had one workspace's save silently
 * rename the landlord party on every lease generated in the other.
 *
 * The owner's account row stays the fallback: a workspace with no row of its own (and an account that
 * saved a name before this rung existed, or with no workspace context at all) resolves to it, then to the
 * owner's `profiles.full_name`.
 */
const NAMESPACE = "landlordProfile" as const;

async function loadLandlordProfileForScope(
  db: SupabaseClient,
  ownerUserId: string,
  workspaceId: string | null,
  cache: SettingsScopeCache,
): Promise<ManagerLandlordProfile> {
  const { value } = await resolveSettingsScope(
    db,
    { managerUserId: ownerUserId, workspaceId },
    NAMESPACE,
    { normalize: normalizeManagerLandlordProfile, loadAccount: (d, m) => loadManagerLandlordProfile(d, m) },
    cache,
  );
  return value;
}

/** The landlord name for one workspace, read as its owner: workspace setting, account setting, owner's full name. */
export async function resolveLandlordLegalNameForScope(
  db: SupabaseClient,
  ownerUserId: string,
  workspaceId: string | null,
  /** Share one cache with the other namespaces a request resolves: the workspace row is read once. */
  cache: SettingsScopeCache = createSettingsScopeCache(),
): Promise<{ landlordLegalName: string; source: LandlordNameSource; setting: string; ownerFullName: string }> {
  const [profile, ownerFullName] = await Promise.all([
    loadLandlordProfileForScope(db, ownerUserId, workspaceId, cache),
    loadManagerLandlordLegalNameFromProfile(db, ownerUserId),
  ]);
  const picked = pickLandlordLegalName({ setting: profile.landlordLegalName, ownerFullName });
  return { ...picked, setting: profile.landlordLegalName, ownerFullName };
}

/** Write the name onto the named workspace; with no workspace in scope it stays the account-wide fallback. */
export async function saveLandlordProfileForScope(
  db: SupabaseClient,
  input: { ownerUserId: string; workspaceId: string | null; landlordLegalName: string },
): Promise<ManagerLandlordProfile> {
  const normalized = normalizeManagerLandlordProfile({ landlordLegalName: input.landlordLegalName });
  if (input.workspaceId) {
    await saveWorkspaceNamespaceSettings(db, input.workspaceId, input.ownerUserId, NAMESPACE, normalized);
    return normalized;
  }
  return saveManagerLandlordProfile(db, input.ownerUserId, normalized);
}
