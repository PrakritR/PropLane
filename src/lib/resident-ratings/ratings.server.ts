import "server-only";

import { isAdminUser } from "@/lib/auth/admin-preview";
import { managerCanAccessApplicationRecord } from "@/lib/auth/manager-application-access";
import { managerHasCoManagerPermissionForProperty } from "@/lib/auth/manager-lease-scope";
import { jointLeaseRowIncludesMember } from "@/lib/bundle-group/joint-lease";
import { leaseIsFullyExecuted, normalizeLeasePipelineRow } from "@/lib/lease-pipeline-storage";
import { normalizeApplicationAxisId } from "@/lib/manager-applications-storage";
import {
  RESIDENCY_REFUSAL_MESSAGE,
  assessResidency,
  isRatingDisputed,
  isSubmittedApplicantRow,
  parseRatingInput,
  parseResponseInput,
  summarizeRatings,
  toManagerFacingRating,
  toResidentFacingRating,
  type ManagerRatingsView,
  type RatingApplicationFacts,
  type RatingSummary,
  type ResidentFacingRating,
  type ResidentRatingRow,
} from "@/lib/resident-ratings/ratings";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

type Db = ReturnType<typeof createSupabaseServiceRoleClient>;

// An id is an `AXIS-…` / `PROPLANE-…` slug and nothing else, so it can never widen a filter on the service-role client.
const APPLICATION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

function idVariants(id: string): string[] {
  const trimmed = id.trim();
  const normalized = normalizeApplicationAxisId(trimmed);
  return [...new Set([trimmed, normalized].filter(Boolean))].filter((value) => APPLICATION_ID_PATTERN.test(value));
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export type RatingFailure = { ok: false; status: number; error: string };

/** Everything the rating rules need about ONE application record, every field re-derived server-side. */
export type RatingSubject = {
  applicationId: string;
  ownerUserId: string | null;
  residentEmail: string;
  propertyId: string;
  workspaceId: string | null;
  houseCity: string | null;
  /** The resident's Auth id, only when the record's account is proven to be the record's own email. */
  residentUserId: string | null;
  facts: RatingApplicationFacts;
};

type LoadedSubject = { ok: true; subject: RatingSubject; admin: boolean };

/**
 * Resolves one application record for the caller and authorizes READING it, twice - the record, then the property
 * re-derived from the stored row without the record's frozen `manager_user_id` (the property id inside `row_data` is
 * writable by whoever owns the record, so the stamp must not stand in for owning the house; the housemates route
 * makes the same second check). Nothing here reads the request body.
 */
export async function loadRatingSubject(db: Db, userId: string, rawId: string): Promise<LoadedSubject | RatingFailure> {
  const ids = idVariants(rawId);
  if (!userId) return { ok: false, status: 401, error: "Unauthorized." };
  if (ids.length === 0) return { ok: false, status: 404, error: "Application not found." };

  const { data: records, error } = await db
    .from("manager_application_records")
    .select("id, row_data, manager_user_id, resident_email, property_id, assigned_property_id")
    .in("id", ids)
    .limit(1);
  if (error) return { ok: false, status: 500, error: "Could not load the record." };
  const record = records?.[0];
  if (!record?.row_data || typeof record.row_data !== "object") {
    return { ok: false, status: 404, error: "Application not found." };
  }

  const admin = await isAdminUser(userId);
  if (!admin && !(await managerCanAccessApplicationRecord(db, userId, record))) {
    return { ok: false, status: 403, error: "Not authorized for this application." };
  }

  const data = record.row_data as Record<string, unknown>;
  const application = data.application && typeof data.application === "object" ? (data.application as Record<string, unknown>) : null;
  const propertyId =
    str(data.assignedPropertyId) || str(record.assigned_property_id) || str(data.propertyId) || str(record.property_id);
  if (!propertyId) return { ok: false, status: 409, error: "This record is not linked to a house." };
  if (!admin && !(await managerCanAccessApplicationRecord(db, userId, { property_id: propertyId }))) {
    return { ok: false, status: 403, error: "Not authorized for this property." };
  }

  const { data: property } = await db
    .from("manager_property_records")
    .select("id, workspace_id, property_data")
    .eq("id", propertyId)
    .maybeSingle();
  const propertyData = (property?.property_data ?? null) as { listingSubmission?: { city?: unknown } } | null;
  const houseCity = str(propertyData?.listingSubmission?.city) || null;

  const residentEmail = str(record.resident_email || data.email).toLowerCase();
  let residentUserId: string | null = null;
  const claimedUserId = str(data.residentUserId);
  if (claimedUserId && residentEmail) {
    // `row_data.residentUserId` is writable by the manager who owns the record, so it is only a claim: it counts
    // when the account it names is the account whose email IS the record's email.
    const { data: profile } = await db.from("profiles").select("id, email").eq("id", claimedUserId).maybeSingle();
    if (profile?.id === claimedUserId && str(profile.email).toLowerCase() === residentEmail) residentUserId = claimedUserId;
  }

  const moveIn = (data.manualResidentDetails as { moveInDate?: unknown } | undefined)?.moveInDate;
  return {
    ok: true,
    admin,
    subject: {
      applicationId: String(record.id),
      ownerUserId: record.manager_user_id ? String(record.manager_user_id) : null,
      residentEmail,
      propertyId,
      workspaceId: property?.workspace_id ? String(property.workspace_id) : null,
      houseCity,
      residentUserId,
      facts: {
        bucket: str(data.bucket) || null,
        stage: str(data.stage) || null,
        manuallyAdded: data.manuallyAdded === true,
        smsLead: data.smsLead === true,
        withdrawnAt: str(data.withdrawnAt) || null,
        mergedInto: str(data.mergedInto) || null,
        bookingResidency: data.bookingResidency === true,
        application: application ?? undefined,
        manualResidentDetails: { moveInDate: typeof moveIn === "string" ? moveIn : null },
        leaseStart: str(application?.leaseStart) || null,
      },
    },
  };
}

/** Is there an executed lease for this record on this house? Read from the lease pipeline, never the request. */
export async function residencyHasExecutedLease(db: Db, subject: RatingSubject): Promise<boolean> {
  const { data, error } = await db
    .from("portal_lease_pipeline_records")
    .select("id, row_data")
    .eq("property_id", subject.propertyId)
    .limit(500);
  if (error) return false;
  for (const stored of data ?? []) {
    if (!stored.row_data || typeof stored.row_data !== "object") continue;
    const lease = normalizeLeasePipelineRow(stored.row_data);
    if (!leaseIsFullyExecuted(lease)) continue;
    if (jointLeaseRowIncludesMember(lease, { email: subject.residentEmail, applicationId: subject.applicationId })) return true;
  }
  return false;
}

async function residencyFor(db: Db, subject: RatingSubject) {
  // Cheap signals first: the lease pipeline is only read when the row itself does not already say "tenancy".
  const selfEvidenced = subject.facts.manuallyAdded === true || subject.facts.bookingResidency === true;
  const leaseExecuted = selfEvidenced ? false : await residencyHasExecutedLease(db, subject);
  return assessResidency(subject.facts, { leaseExecuted });
}

/** The ONE write decision: the rater's workspace must have housed this person AND the rater must edit Residents there. */
async function canRateHere(db: Db, userId: string, subject: RatingSubject): Promise<boolean> {
  if (!subject.workspaceId) return false;
  // Direct owner passes; a co-manager needs the Residents module at EDIT on this house (a Viewer seat has read only).
  return managerHasCoManagerPermissionForProperty(db, userId, subject.propertyId, "residents", "edit", { strict: true });
}

/* ------------------------------ manager reads ----------------------------- */

const NO_ACCOUNT_REFUSAL = "This resident has no PropLane account yet, so there is no one to attach a rating to.";

const EMPTY_VIEW: ManagerRatingsView = {
  available: false,
  summary: { average: null, count: 0 },
  ratings: [],
  own: null,
  canRate: false,
  rateRefusal: null,
};

export async function loadManagerRatingsView(db: Db, userId: string, rawId: string): Promise<{ ok: true; view: ManagerRatingsView } | RatingFailure> {
  const loaded = await loadRatingSubject(db, userId, rawId);
  if (!loaded.ok) return loaded;
  const { subject, admin } = loaded;
  if (!subject.residentUserId) return { ok: true, view: { ...EMPTY_VIEW, rateRefusal: NO_ACCOUNT_REFUSAL } };

  const submitted = isSubmittedApplicantRow(subject.facts);
  const residency = await residencyFor(db, subject);
  // Ratings open on an application the resident actually submitted, and on the manager's own residents' records.
  if (!submitted && !residency.ok) return { ok: true, view: EMPTY_VIEW };

  const { data, error } = await db
    .from("resident_ratings")
    .select("*")
    .eq("resident_user_id", subject.residentUserId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) return { ok: false, status: 500, error: "Could not load ratings." };
  const rows = (data ?? []) as ResidentRatingRow[];

  const ownRow = rows.find((row) => row.workspace_id === subject.workspaceId && row.residency_ref === subject.applicationId) ?? null;
  const canRate = !admin && residency.ok && (await canRateHere(db, userId, subject));
  return {
    ok: true,
    view: {
      available: true,
      summary: summarizeRatings(rows),
      ratings: rows.map((row) => toManagerFacingRating(row, { viewerWorkspaceId: subject.workspaceId })),
      own: ownRow ? { stars: ownRow.stars, review: ownRow.review } : null,
      canRate,
      rateRefusal: residency.ok ? null : RESIDENCY_REFUSAL_MESSAGE[residency.reason],
    },
  };
}

/* ------------------------------ manager write ----------------------------- */

export async function saveManagerRating(
  db: Db,
  userId: string,
  rawId: string,
  body: unknown,
): Promise<{ ok: true; view: ManagerRatingsView } | RatingFailure> {
  const parsed = parseRatingInput(body);
  if (!parsed.ok) return { ok: false, status: 422, error: parsed.error };

  const loaded = await loadRatingSubject(db, userId, rawId);
  if (!loaded.ok) return loaded;
  const { subject, admin } = loaded;
  if (admin) return { ok: false, status: 403, error: "Only the workspace that housed this person can rate them." };

  const residency = await residencyFor(db, subject);
  if (!residency.ok) return { ok: false, status: 409, error: RESIDENCY_REFUSAL_MESSAGE[residency.reason] };
  if (!subject.residentUserId) {
    return { ok: false, status: 409, error: NO_ACCOUNT_REFUSAL };
  }
  if (!(await canRateHere(db, userId, subject))) {
    return { ok: false, status: 403, error: "You need edit access to Residents to rate someone." };
  }

  const workspaceId = subject.workspaceId as string;
  const { data: existing, error: readError } = await db
    .from("resident_ratings")
    .select("*")
    .eq("residency_ref", subject.applicationId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (readError) return { ok: false, status: 500, error: "Could not save the rating." };

  const now = new Date().toISOString();
  if (existing) {
    const row = existing as ResidentRatingRow;
    // The rater edits theirs. A teammate's rating stays theirs, unless the rater's login is gone or the editor owns
    // the house.
    const mayEdit =
      row.rater_user_id === userId || row.rater_user_id === null || subject.ownerUserId === userId;
    if (!mayEdit) return { ok: false, status: 409, error: "A teammate already rated this stay. Only they can change it." };
    const { error } = await db
      .from("resident_ratings")
      .update({
        stars: parsed.value.stars,
        review: parsed.value.review,
        rater_user_id: row.rater_user_id ?? userId,
        updated_at: now,
      })
      .eq("id", row.id)
      .eq("resident_user_id", subject.residentUserId);
    if (error) return { ok: false, status: 500, error: "Could not save the rating." };
  } else {
    const { error } = await db.from("resident_ratings").insert({
      // Every identity below is derived: the resident from the record's own account, the rater from the session, the
      // workspace from the house. Nothing in the request body reaches these columns.
      resident_user_id: subject.residentUserId,
      rater_user_id: userId,
      workspace_id: workspaceId,
      residency_ref: subject.applicationId,
      house_city: subject.houseCity,
      stars: parsed.value.stars,
      review: parsed.value.review,
    });
    if (error) {
      // The unique (residency_ref, workspace_id) index: a concurrent rating won, so this is a second one.
      if ((error as { code?: string }).code === "23505") {
        return { ok: false, status: 409, error: "This stay already has a rating. Reload to edit it." };
      }
      return { ok: false, status: 500, error: "Could not save the rating." };
    }
  }

  const view = await loadManagerRatingsView(db, userId, rawId);
  return view;
}

/* ----------------------------- resident side ------------------------------ */

export async function listRatingsForResident(db: Db, residentUserId: string): Promise<ResidentFacingRating[]> {
  if (!residentUserId) return [];
  const { data, error } = await db
    .from("resident_ratings")
    .select("*")
    .eq("resident_user_id", residentUserId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw new Error(error.message);
  return ((data ?? []) as ResidentRatingRow[]).map((row) => toResidentFacingRating(row));
}

async function loadOwnRating(db: Db, residentUserId: string, ratingId: string): Promise<ResidentRatingRow | null> {
  if (!residentUserId || !/^[0-9a-f-]{36}$/i.test(ratingId)) return null;
  const { data } = await db
    .from("resident_ratings")
    .select("*")
    .eq("id", ratingId)
    .eq("resident_user_id", residentUserId)
    .maybeSingle();
  return (data as ResidentRatingRow | null) ?? null;
}

/** One public response per rating. The resident may edit or clear it; only their own rating can be answered. */
export async function saveResidentResponse(
  db: Db,
  residentUserId: string,
  ratingId: string,
  body: unknown,
): Promise<{ ok: true; rating: ResidentFacingRating } | RatingFailure> {
  const parsed = parseResponseInput(body);
  if (!parsed.ok) return { ok: false, status: 422, error: parsed.error };
  const row = await loadOwnRating(db, residentUserId, ratingId);
  if (!row) return { ok: false, status: 404, error: "Rating not found." };
  const now = new Date().toISOString();
  const { data, error } = await db
    .from("resident_ratings")
    .update({
      resident_response: parsed.value || null,
      response_at: parsed.value ? now : null,
      updated_at: now,
    })
    .eq("id", row.id)
    .eq("resident_user_id", residentUserId)
    .select("*")
    .maybeSingle();
  if (error || !data) return { ok: false, status: 500, error: "Could not save your response." };
  return { ok: true, rating: toResidentFacingRating(data as ResidentRatingRow) };
}

/**
 * A resident disputes a rating: it is routed to PropLane support as a thread in the shared admin inbox, and until an
 * admin resolves it future managers read "Disputed by resident" beside it. The thread goes first, so a rating is
 * never marked disputed with no one told. Idempotent: a rating already under dispute opens no second thread.
 */
export async function disputeResidentRating(
  db: Db,
  resident: { userId: string; email: string; name: string },
  ratingId: string,
  body: unknown,
): Promise<{ ok: true; rating: ResidentFacingRating; alreadyDisputed: boolean } | RatingFailure> {
  const row = await loadOwnRating(db, resident.userId, ratingId);
  if (!row) return { ok: false, status: 404, error: "Rating not found." };
  if (isRatingDisputed(row)) return { ok: true, rating: toResidentFacingRating(row), alreadyDisputed: true };

  const source = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const reason = typeof source.reason === "string" ? source.reason.trim().slice(0, 1000) : "";
  const { deliverPortalMessageToAdminSharedInbox } = await import("@/lib/admin-shared-inbox.server");
  try {
    await deliverPortalMessageToAdminSharedInbox(db as never, {
      senderEmail: resident.email,
      senderName: resident.name,
      senderRole: "resident",
      subject: "Rating dispute",
      body: [
        `I am disputing a rating on my PropLane record (rating ${row.id}).`,
        `${row.stars} of 5 stars, ${row.created_at.slice(0, 10)}.`,
        reason ? `Why: ${reason}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    });
  } catch {
    return { ok: false, status: 502, error: "Could not reach PropLane support. Try again." };
  }

  const now = new Date().toISOString();
  const { data, error } = await db
    .from("resident_ratings")
    .update({ disputed_at: now, dispute_resolved_at: null, updated_at: now })
    .eq("id", row.id)
    .eq("resident_user_id", resident.userId)
    .select("*")
    .maybeSingle();
  if (error || !data) return { ok: false, status: 500, error: "Could not record the dispute." };
  return { ok: true, rating: toResidentFacingRating(data as ResidentRatingRow), alreadyDisputed: false };
}

/** PropLane staff close a dispute: the rating stands (resolved) or goes (remove). Admin routes only. */
export async function resolveRatingDispute(
  db: Db,
  ratingId: string,
  action: "keep" | "remove",
): Promise<{ ok: true } | RatingFailure> {
  if (!/^[0-9a-f-]{36}$/i.test(ratingId)) return { ok: false, status: 404, error: "Rating not found." };
  if (action === "remove") {
    const { error } = await db.from("resident_ratings").delete().eq("id", ratingId);
    return error ? { ok: false, status: 500, error: "Could not remove the rating." } : { ok: true };
  }
  const now = new Date().toISOString();
  const { error } = await db
    .from("resident_ratings")
    .update({ dispute_resolved_at: now, updated_at: now })
    .eq("id", ratingId);
  return error ? { ok: false, status: 500, error: "Could not resolve the dispute." } : { ok: true };
}
