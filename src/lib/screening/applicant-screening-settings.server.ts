import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  defaultApplicantScreeningSettings,
  normalizeApplicantScreeningSettings,
  type ApplicantScreeningSettings,
} from "@/lib/screening/applicant-screening";
import { ForeignPropertyError } from "@/lib/settings/property-overrides.server";
import {
  createSettingsScopeCache,
  resolveSettingsScope,
  type SettingsResolutionSource,
  type SettingsScopeCache,
} from "@/lib/settings/scope-resolver.server";

export const APPLICANT_SCREENING_NAMESPACE = "applicantScreening" as const;

/** The workspace a property belongs to, and whether PropLane manages it (`portal_workspaces.is_service`). Fails to self-serve. */
async function managedWorkspaceFor(
  db: SupabaseClient,
  input: { propertyId: string | null; workspaceId: string | null },
): Promise<{ workspaceId: string | null; managed: boolean }> {
  let workspaceId = input.workspaceId;
  if (!workspaceId && input.propertyId) {
    const { data } = await db
      .from("manager_property_records")
      .select("workspace_id")
      .eq("id", input.propertyId)
      .maybeSingle();
    workspaceId = data?.workspace_id ? String(data.workspace_id) : null;
  }
  if (!workspaceId) return { workspaceId: null, managed: false };
  const { data, error } = await db
    .from("portal_workspaces")
    .select("is_service")
    .eq("id", workspaceId)
    .maybeSingle();
  if (error) return { workspaceId, managed: false };
  return { workspaceId, managed: data?.is_service === true };
}

/**
 * The applicant checks one listing offers: this property's own choice, else the workspace's, else the default
 * (OFF for every workspace until the manager turns it on). `managerUserId` is the listing OWNER, derived by the
 * caller from the stored application/property, never from a request.
 */
export async function resolveApplicantScreeningSettings(
  db: SupabaseClient,
  input: { managerUserId: string; propertyId?: string | null; workspaceId?: string | null },
  cache: SettingsScopeCache = createSettingsScopeCache(),
): Promise<{ settings: ApplicantScreeningSettings; source: SettingsResolutionSource; managed: boolean }> {
  const propertyId = input.propertyId?.trim() || null;
  const { workspaceId, managed } = await managedWorkspaceFor(db, {
    propertyId,
    workspaceId: input.workspaceId?.trim() || null,
  });
  const defaults = defaultApplicantScreeningSettings(managed);
  try {
    const { value, source } = await resolveSettingsScope(
      db,
      { managerUserId: input.managerUserId, propertyId, workspaceId },
      APPLICANT_SCREENING_NAMESPACE,
      { normalize: (raw) => normalizeApplicantScreeningSettings(raw, defaults), defaultValue: defaults },
      cache,
    );
    return { settings: value, source, managed };
  } catch (error) {
    // A property the manager id does not own has no override of its own: the default answers, never a throw.
    if (error instanceof ForeignPropertyError) return { settings: defaults, source: "default", managed };
    throw error;
  }
}
