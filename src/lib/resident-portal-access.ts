import { cache } from "react";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import type {
  ManagerSubscriptionTier,
  ResidentPortalAccessState,
} from "@/lib/resident-portal-access-types";

export type { ManagerSubscriptionTier, ResidentPortalAccessState } from "@/lib/resident-portal-access-types";
export { residentPortalHomePath } from "@/lib/resident-portal-nav";

function emptyAccessState(managerSubscriptionTier: ManagerSubscriptionTier): ResidentPortalAccessState {
  return {
    roleOk: false,
    hasSubmittedApplication: false,
    hasCompletedApplicationSubmission: false,
    isPreApplicationResident: false,
    hasTourLink: false,
    isPreLeaseResident: false,
    applicationApproved: false,
    applicationId: null,
    applicationStage: null,
    applicationProperty: null,
    leaseSigned: false,
    leaseAccessUnlocked: false,
    fullPortalAccess: false,
    managerSubscriptionTier,
  };
}

function normalizeEmail(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isInProgressApplicationStage(stage: string | null | undefined): boolean {
  return stage?.trim().toLowerCase() === "in progress";
}

function readLatestApplication(
  records: Array<{ row_data: unknown; updated_at?: string | null }>,
  email: string,
  userId?: string | null,
): {
  id: string | null;
  bucket: string | null;
  stage: string | null;
  property: string | null;
} {
  const matching = records
    .map((record) => {
      const row = record.row_data && typeof record.row_data === "object" && !Array.isArray(record.row_data)
        ? (record.row_data as Record<string, unknown>)
        : null;
      const residentEmail = normalizeEmail(typeof row?.email === "string" ? row.email : null);
      if (!row || residentEmail !== email) return null;
      const linkedUserId = typeof row.residentUserId === "string" ? row.residentUserId.trim() : "";
      if (linkedUserId && userId && linkedUserId !== userId) return null;
      return {
        id: typeof row.id === "string" ? row.id.trim() || null : null,
        bucket: typeof row.bucket === "string" ? row.bucket.trim().toLowerCase() || null : null,
        stage: typeof row.stage === "string" ? row.stage.trim() || null : null,
        property: typeof row.property === "string" ? row.property.trim() || null : null,
        updatedAt: typeof record.updated_at === "string" ? record.updated_at : "",
      };
    })
    .filter(Boolean) as Array<{
      id: string | null;
      bucket: string | null;
      stage: string | null;
      property: string | null;
      updatedAt: string;
    }>;

  if (!matching.length) {
    return { id: null, bucket: null, stage: null, property: null };
  }

  matching.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const latest = matching[0]!;
  return {
    id: latest.id,
    bucket: latest.bucket,
    stage: latest.stage,
    property: latest.property,
  };
}

/** Server-side: returns true when the resident has a lease that both manager and resident signed. */
export async function loadResidentLeaseSignedStatus(email: string): Promise<boolean> {
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail) return false;
  const db = createSupabaseServiceRoleClient();
  const { data } = await db
    .from("portal_lease_pipeline_records")
    .select("row_data")
    .eq("resident_email", normalizedEmail)
    .order("updated_at", { ascending: false });
  if (!data?.length) return false;
  return data.some((record) => {
    const row = record.row_data as Record<string, unknown> | null;
    if (!row) return false;
    if (row.externallySignedLease === true) {
      const mgr = row.managerSignature as Record<string, unknown> | null | undefined;
      const res = row.residentSignature as Record<string, unknown> | null | undefined;
      return Boolean(mgr?.name && mgr?.signedAtIso && res?.name && res?.signedAtIso);
    }
    const mgr = row.managerSignature as Record<string, unknown> | null | undefined;
    const res = row.residentSignature as Record<string, unknown> | null | undefined;
    const legacyName = typeof row.signatureName === "string" ? row.signatureName : null;
    const legacyAt = typeof row.signedAtIso === "string" ? row.signedAtIso : null;
    const managerSigned = Boolean(mgr?.name && mgr?.signedAtIso);
    const residentSigned = Boolean((res?.name && res?.signedAtIso) || (legacyName && legacyAt));
    return managerSigned && residentSigned;
  });
}

/**
 * Whether this account HOLDS the resident role, from the multi-role source of
 * truth (`profile_roles`) rather than the legacy single-value `profiles.role`.
 *
 * `profiles.role` records only whichever role the account was CREATED as, so a
 * resident who is also a manager reads back as `"manager"` forever. Every portal
 * guard already knows this and authorizes off `profile_roles` (`hasRole` in
 * `portal-access.ts`), but the resident ACCESS resolver did not — so the layout
 * admitted a manager+resident into /resident and then handed them
 * `emptyAccessState`, which resolves to nav stage `pre_approval`. That locked
 * Lease, House details, Services, Payments and Documents, and made
 * `/resident/lease` redirect to the apply wizard, no matter how approved their
 * application was: the role check short-circuits before any application is read.
 */
async function holdsResidentRole(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  userId: string,
): Promise<boolean> {
  const { data } = await db
    .from("profile_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "resident")
    .maybeSingle();
  return Boolean(data);
}

const loadResidentPortalAccessStateCached = cache(
  async (
    userId: string | null,
    role: string | null,
    email: string,
    managerSubscriptionTier: ManagerSubscriptionTier,
  ): Promise<ResidentPortalAccessState> => {
    if (!email) return emptyAccessState(managerSubscriptionTier);

    const db = createSupabaseServiceRoleClient();
    // Fast path stays query-free for the single-role resident (the common case);
    // the extra lookup only runs for an account whose legacy role says otherwise.
    const roleOk =
      !role || role === "resident" || (userId ? await holdsResidentRole(db, userId) : false);
    if (!roleOk) return emptyAccessState(managerSubscriptionTier);

    const { data: applicationRows } = await db
      .from("manager_application_records")
      .select("row_data, updated_at")
      .eq("resident_email", email)
      .order("updated_at", { ascending: false });

    let latestApplication = readLatestApplication(applicationRows ?? [], email, userId);
    let hasSubmittedApplication = (applicationRows ?? []).some((record) => {
      const row = record.row_data && typeof record.row_data === "object" && !Array.isArray(record.row_data)
        ? (record.row_data as Record<string, unknown>)
        : null;
      const residentEmail = normalizeEmail(typeof row?.email === "string" ? row.email : null);
      if (!row || residentEmail !== email) return false;
      const linkedUserId = typeof row.residentUserId === "string" ? row.residentUserId.trim() : "";
      if (linkedUserId && userId && linkedUserId !== userId) return false;
      return true;
    });
    let hasCompletedApplicationSubmission = (applicationRows ?? []).some((record) => {
      const row = record.row_data && typeof record.row_data === "object" && !Array.isArray(record.row_data)
        ? (record.row_data as Record<string, unknown>)
        : null;
      const residentEmail = normalizeEmail(typeof row?.email === "string" ? row.email : null);
      if (!row || residentEmail !== email) return false;
      const linkedUserId = typeof row.residentUserId === "string" ? row.residentUserId.trim() : "";
      if (linkedUserId && userId && linkedUserId !== userId) return false;
      const stage = typeof row.stage === "string" ? row.stage : null;
      return !isInProgressApplicationStage(stage);
    });
    let applicationApproved = latestApplication.bucket === "approved";

    if ((!latestApplication.id || !applicationApproved) && userId) {
      const { data: profile } = await db
        .from("profiles")
        .select("application_approved, manager_id")
        .eq("id", userId)
        .maybeSingle();

      const profileAxisId = typeof profile?.manager_id === "string" ? profile.manager_id.trim() : "";
      if (
        profileAxisId &&
        (profileAxisId.toUpperCase().startsWith("AXIS-") || profileAxisId.toUpperCase().startsWith("PROPLANE-"))
      ) {
        const { data: axisRecord } = await db
          .from("manager_application_records")
          .select("row_data, updated_at")
          .eq("id", profileAxisId)
          .maybeSingle();

        if (axisRecord?.row_data && typeof axisRecord.row_data === "object" && !Array.isArray(axisRecord.row_data)) {
          const axisRow = axisRecord.row_data as Record<string, unknown>;
          hasSubmittedApplication = true;
          hasCompletedApplicationSubmission =
            hasCompletedApplicationSubmission ||
            !isInProgressApplicationStage(typeof axisRow.stage === "string" ? axisRow.stage : null);
          latestApplication = {
            id: typeof axisRow.id === "string" ? axisRow.id.trim() || null : null,
            bucket: typeof axisRow.bucket === "string" ? axisRow.bucket.trim().toLowerCase() || null : null,
            stage: typeof axisRow.stage === "string" ? axisRow.stage.trim() || null : null,
            property: typeof axisRow.property === "string" ? axisRow.property.trim() || null : null,
          };
          applicationApproved = latestApplication.bucket === "approved";
        }
      }

      if (!applicationApproved) {
        applicationApproved = Boolean(profile?.application_approved === true);
      }
    }

    const leaseSigned = await loadResidentLeaseSignedStatus(email);
    const leaseAccessUnlocked = leaseSigned;
    let hasTourLink = false;
    if (userId) {
      const { count: tourLinkCount } = await db
        .from("resident_tour_links")
        .select("id", { count: "exact", head: true })
        .eq("resident_user_id", userId);
      hasTourLink = (tourLinkCount ?? 0) > 0;
    }
    const isPreLeaseResident =
      roleOk && !leaseSigned && (hasTourLink || hasSubmittedApplication || applicationApproved);

    return {
      roleOk,
      hasSubmittedApplication,
      hasCompletedApplicationSubmission,
      isPreApplicationResident: roleOk && !hasSubmittedApplication && !hasTourLink,
      hasTourLink,
      isPreLeaseResident,
      applicationApproved,
      applicationId: latestApplication.id,
      applicationStage: latestApplication.stage,
      applicationProperty: latestApplication.property,
      leaseSigned,
      leaseAccessUnlocked,
      fullPortalAccess: leaseSigned,
      managerSubscriptionTier,
    };
  },
);

export async function loadResidentPortalAccessState(params: {
  userId: string | null | undefined;
  role: string | null | undefined;
  email: string | null | undefined;
  managerSubscriptionTier?: ManagerSubscriptionTier;
}): Promise<ResidentPortalAccessState> {
  const managerSubscriptionTier = params.managerSubscriptionTier ?? null;
  const email = normalizeEmail(params.email);
  return loadResidentPortalAccessStateCached(
    params.userId ?? null,
    params.role ?? null,
    email,
    managerSubscriptionTier,
  );
}

export function residentHasFullPortalAccess(params: {
  applicationApproved: boolean;
  leaseSigned?: boolean;
  role: string | null | undefined;
  email: string | null | undefined;
  managerSubscriptionTier?: ManagerSubscriptionTier;
}): boolean {
  if (params.role && params.role !== "resident") return false;
  if (params.leaseSigned === true) return true;
  return false;
}
