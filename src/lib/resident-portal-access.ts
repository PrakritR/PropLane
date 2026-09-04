import { cache } from "react";
import { authorizeResidentRole } from "@/lib/auth/resident-role-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { residentHasTourLinks } from "@/lib/tour-resident-link.server";
import { isWithdrawnApplicationRow } from "@/lib/rental-application/resident-application-list";
import { residentOwnsApplicationRow } from "@/lib/rental-application/resident-application-ownership";
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

type ApplicationRecord = {
  row_data: unknown;
  updated_at?: string | null;
  resident_email?: string | null;
};

type OwnedApplication = {
  id: string | null;
  bucket: string | null;
  stage: string | null;
  property: string | null;
  updatedAt: string;
};

/**
 * The applications this resident owns — the SAME predicate the resident's own
 * Applications tab uses (`GET /api/manager-applications`, which for a resident
 * overrides `row_data.email` with the `resident_email` COLUMN and then filters
 * with `residentOwnsApplicationRow`), plus that list's withdrawn-row exclusion.
 *
 * Matching on `row_data.email` alone instead is how the nav went blind to a
 * plainly approved application: the column and the embedded copy drift (the
 * manager typed a different address, the resident later changed theirs), so the
 * Applications tab counted "Approved 1" while this resolver saw nothing at all
 * and dropped the resident back to the `pre_approval` stage — Lease, Payments
 * and the whole bottom bar locked. Scope on the column, which is what the query
 * above already filters by, so the two surfaces can never disagree.
 */
function readOwnedApplications(
  records: ApplicationRecord[],
  email: string,
  userId?: string | null,
): OwnedApplication[] {
  const owned = records.flatMap((record) => {
    const row = record.row_data && typeof record.row_data === "object" && !Array.isArray(record.row_data)
      ? (record.row_data as Record<string, unknown>)
      : null;
    if (!row) return [];
    const recordEmail = normalizeEmail(record.resident_email);
    // Mirror the resident-scoped API: the stored column is the resident's address,
    // so `email` is pinned to it and a non-string `row_data.email` never reaches
    // `normalizeEmail`. Re-checking with the shared predicate is intentionally
    // belt-and-braces over the already-scoped query above, so widening that query
    // later cannot silently widen this resolver's scope.
    const rowEmail = typeof row.email === "string" ? row.email : "";
    const rowForOwnership = { ...row, email: recordEmail || rowEmail } as Parameters<
      typeof residentOwnsApplicationRow
    >[0];
    if (!residentOwnsApplicationRow(rowForOwnership, { email, userId }, { recordEmail })) return [];
    if (isWithdrawnApplicationRow(rowForOwnership)) return [];
    return [
      {
        id: typeof row.id === "string" ? row.id.trim() || null : null,
        bucket: typeof row.bucket === "string" ? row.bucket.trim().toLowerCase() || null : null,
        stage: typeof row.stage === "string" ? row.stage.trim() || null : null,
        property: typeof row.property === "string" ? row.property.trim() || null : null,
        updatedAt: typeof record.updated_at === "string" ? record.updated_at : "",
      },
    ];
  });

  owned.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return owned;
}

function latestApplicationOf(owned: OwnedApplication[]): {
  id: string | null;
  bucket: string | null;
  stage: string | null;
  property: string | null;
} {
  const latest = owned[0];
  if (!latest) return { id: null, bucket: null, stage: null, property: null };
  return { id: latest.id, bucket: latest.bucket, stage: latest.stage, property: latest.property };
}

/** Server-side: returns true when the resident has a lease that both manager and resident signed. */
/**
 * A manager attested this person is an existing tenant.
 *
 * "Onboard an existing resident" is the flow for someone who signed on paper
 * before PropLane, so having no PDF is the NORMAL case there. Keying portal
 * access on a signed document therefore locked a real rent-paying tenant out of
 * Payments, Services, Lease and Documents entirely, and showed them Tour and
 * Application tabs instead (PRP-239). The gate keys on the tenancy as well.
 *
 * Kept separate from `loadResidentLeaseSignedStatus`: this is NOT a signature,
 * and nothing downstream that asks "is the lease signed" should start getting
 * `true` for a lease that is not.
 */
export async function loadResidentManagerAttestedTenancy(
  email: string,
  managerUserId?: string,
): Promise<boolean> {
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail) return false;
  const db = createSupabaseServiceRoleClient();
  let query = db
    .from("portal_lease_pipeline_records")
    .select("row_data")
    .eq("resident_email", normalizedEmail);
  if (managerUserId) query = query.eq("manager_user_id", managerUserId);
  const { data } = await query.order("updated_at", { ascending: false });
  return (data ?? []).some((record) => {
    const row = record.row_data as Record<string, unknown> | null;
    return Boolean(row && typeof row.managerAttestedTenancyAt === "string" && row.managerAttestedTenancyAt.trim());
  });
}

export async function loadResidentLeaseSignedStatus(email: string, managerUserId?: string): Promise<boolean> {
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail) return false;
  const db = createSupabaseServiceRoleClient();
  let query = db
    .from("portal_lease_pipeline_records")
    .select("row_data")
    .eq("resident_email", normalizedEmail);
  if (managerUserId) query = query.eq("manager_user_id", managerUserId);
  const { data } = await query.order("updated_at", { ascending: false });
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

const loadResidentPortalAccessStateCached = cache(
  async (
    userId: string | null,
    role: string | null,
    email: string,
    managerSubscriptionTier: ManagerSubscriptionTier,
    managerUserId: string | null,
  ): Promise<ResidentPortalAccessState> => {
    if (!email) return emptyAccessState(managerSubscriptionTier);

    const db = createSupabaseServiceRoleClient();
    // Fast path stays query-free for the single-role resident (the common case);
    // the extra lookup only runs for an account whose legacy role says otherwise.
    const roleOk = await authorizeResidentRole(db, { userId, legacyRole: role });
    if (!roleOk) return emptyAccessState(managerSubscriptionTier);

    let applicationQuery = db
      .from("manager_application_records")
      .select("row_data, updated_at, resident_email")
      .eq("resident_email", email);
    if (managerUserId) applicationQuery = applicationQuery.eq("manager_user_id", managerUserId);
    const { data: applicationRows } = await applicationQuery.order("updated_at", { ascending: false });

    const ownedApplications = readOwnedApplications(applicationRows ?? [], email, userId);
    let latestApplication = latestApplicationOf(ownedApplications);
    let hasSubmittedApplication = ownedApplications.length > 0;
    let hasCompletedApplicationSubmission = ownedApplications.some(
      (application) => !isInProgressApplicationStage(application.stage),
    );
    // ANY approved application unlocks the approved stage — not just the newest
    // row. A resident who applies to a second property after being approved for
    // the first must not be dropped back to the pre-approval nav.
    let applicationApproved = ownedApplications.some((application) => application.bucket === "approved");

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
          .select("row_data, updated_at, manager_user_id")
          .eq("id", profileAxisId)
          .maybeSingle();

        if (
          axisRecord?.row_data &&
          typeof axisRecord.row_data === "object" &&
          !Array.isArray(axisRecord.row_data) &&
          (!managerUserId || axisRecord.manager_user_id === managerUserId)
        ) {
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
          // Never let this legacy lookup CLEAR an approval already found above.
          applicationApproved = applicationApproved || latestApplication.bucket === "approved";
        }
      }

      if (!applicationApproved && !managerUserId) {
        applicationApproved = Boolean(profile?.application_approved === true);
      }
    }

    const leaseSigned = await loadResidentLeaseSignedStatus(email, managerUserId ?? undefined);
    // A tenant onboarded from a paper lease has no signed document and is still
    // a tenant. `leaseSigned` stays honest about the document; access keys on
    // either (PRP-239).
    const attestedTenancy = leaseSigned
      ? false
      : await loadResidentManagerAttestedTenancy(email, managerUserId ?? undefined);
    const leaseAccessUnlocked = leaseSigned || attestedTenancy;
    let hasTourLink = false;
    if (userId) {
      hasTourLink = await residentHasTourLinks(db, userId, email);
    }
    const isPreLeaseResident =
      roleOk && !leaseAccessUnlocked && (hasTourLink || hasSubmittedApplication || applicationApproved);

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
  /** Optional owner scope for verified resident SMS; portal callers omit it. */
  managerUserId?: string | null;
}): Promise<ResidentPortalAccessState> {
  const managerSubscriptionTier = params.managerSubscriptionTier ?? null;
  const email = normalizeEmail(params.email);
  return loadResidentPortalAccessStateCached(
    params.userId ?? null,
    params.role ?? null,
    email,
    managerSubscriptionTier,
    params.managerUserId?.trim() || null,
  );
}
