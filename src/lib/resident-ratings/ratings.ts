/**
 * Resident ratings, the pure half (no I/O): input parsing, which application rows count as a real residency or a
 * submitted application, and the ONE projection a future manager reads. The server half
 * (`ratings.server.ts`) loads rows and authorizes; this file decides shape, so the rules are unit-testable and
 * `docs/agents/resident-ratings.md` has one place to point at.
 */

export const RATING_REVIEW_MAX = 1000;
export const RATING_RESPONSE_MAX = 500;
export const RATING_STARS_MIN = 1;
export const RATING_STARS_MAX = 5;

/**
 * Shown once, where the applicant authorizes screening, beside the consumer-report disclosure.
 * NEEDS COUNSEL REVIEW before live rollout (FCRA / WA tenant-screening) - see `docs/agents/resident-ratings.md`.
 */
export const RATINGS_DISCLOSURE_LINE = "Managers you apply to can see ratings from your past PropLane stays.";

export const RATING_DISPUTE_LABEL = "Disputed by resident";
/** What a future manager sees in place of who rated. Never the rater's name, the workspace or the address. */
export const RATING_RATER_LABEL = "A previous manager";

/** The stored row (`public.resident_ratings`). Never serialized to a client as is. */
export type ResidentRatingRow = {
  id: string;
  resident_user_id: string;
  rater_user_id: string | null;
  workspace_id: string | null;
  residency_ref: string;
  house_city: string | null;
  stars: number;
  review: string;
  resident_response: string | null;
  response_at: string | null;
  disputed_at: string | null;
  dispute_resolved_at: string | null;
  created_at: string;
  updated_at: string;
};

/* --------------------------------- input --------------------------------- */

export type RatingInput = { stars: number; review: string };

export function parseRatingInput(body: unknown): { ok: true; value: RatingInput } | { ok: false; error: string } {
  const source = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const rawStars = source.stars;
  const stars = typeof rawStars === "number" ? rawStars : typeof rawStars === "string" ? Number(rawStars) : NaN;
  if (!Number.isInteger(stars) || stars < RATING_STARS_MIN || stars > RATING_STARS_MAX) {
    return { ok: false, error: "Choose 1 to 5 stars." };
  }
  const review = typeof source.review === "string" ? source.review.trim() : "";
  if (review.length > RATING_REVIEW_MAX) {
    return { ok: false, error: `Keep the review to ${RATING_REVIEW_MAX} characters.` };
  }
  // Anything else in the body (a resident id, a workspace id, a rater id) is dropped here on purpose: every one of
  // those is re-derived on the server from the authenticated session and the stored application record.
  return { ok: true, value: { stars, review } };
}

export function parseResponseInput(body: unknown): { ok: true; value: string } | { ok: false; error: string } {
  const source = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const response = typeof source.response === "string" ? source.response.trim() : "";
  if (response.length > RATING_RESPONSE_MAX) {
    return { ok: false, error: `Keep your response to ${RATING_RESPONSE_MAX} characters.` };
  }
  return { ok: true, value: response };
}

/* ------------------------- which rows are eligible ------------------------ */

/** The non-sensitive slice of a stored application row these rules read. */
export type RatingApplicationFacts = {
  bucket?: string | null;
  stage?: string | null;
  manuallyAdded?: boolean | null;
  smsLead?: boolean | null;
  withdrawnAt?: string | null;
  mergedInto?: string | null;
  bookingResidency?: boolean | null;
  application?: unknown;
  manualResidentDetails?: { moveInDate?: string | null } | null;
  /** `application.leaseStart` when the applicant filled the form. */
  leaseStart?: string | null;
};

export type ResidencyRefusal = "not_approved" | "not_started" | "no_lease_or_stay";

function ymd(value: string | null | undefined): string {
  const match = /^\d{4}-\d{2}-\d{2}/.exec(String(value ?? "").trim());
  return match ? match[0] : "";
}

/**
 * Has this person REALLY lived (or be living) in the rater's workspace? An approved application is not a stay: the
 * tenancy starts at the executed lease, an approved guest booking, or a manager's own onboarding of an existing
 * tenant (`manuallyAdded`, the same signals `residentDirectoryStage` uses). A move-in date still in the future is not
 * a stay yet. `leaseExecuted` is the server's answer from the lease pipeline, never the request's.
 */
export function assessResidency(
  facts: RatingApplicationFacts,
  evidence: { leaseExecuted: boolean; today?: string },
): { ok: true } | { ok: false; reason: ResidencyRefusal } {
  if (facts.smsLead || facts.withdrawnAt || facts.mergedInto || facts.bucket !== "approved") {
    return { ok: false, reason: "not_approved" };
  }
  const tenancy = evidence.leaseExecuted || facts.manuallyAdded === true || facts.bookingResidency === true;
  if (!tenancy) return { ok: false, reason: "no_lease_or_stay" };
  const today = evidence.today ?? new Date().toISOString().slice(0, 10);
  const start = ymd(facts.manualResidentDetails?.moveInDate) || ymd(facts.leaseStart);
  if (start && start > today) return { ok: false, reason: "not_started" };
  return { ok: true };
}

export const RESIDENCY_REFUSAL_MESSAGE: Record<ResidencyRefusal, string> = {
  not_approved: "You can rate someone once they have lived with you.",
  not_started: "You can rate someone once their stay has started.",
  no_lease_or_stay: "You can rate someone once they have a signed lease or a stay with you.",
};

/**
 * Did the applicant themselves submit this to the manager's workspace? A manager-entered resident
 * (`manuallyAdded`), an SMS placeholder, an unfinished draft and a withdrawn row are not a submission, so none of
 * them opens another workspace's ratings (an email typed in by a manager is not proof of who someone is).
 */
export function isSubmittedApplicantRow(facts: RatingApplicationFacts): boolean {
  if (facts.manuallyAdded === true || facts.smsLead === true || facts.withdrawnAt || facts.mergedInto) return false;
  if (facts.bookingResidency === true) return false;
  if (facts.bucket !== "pending" && facts.bucket !== "approved" && facts.bucket !== "rejected") return false;
  if (facts.bucket === "pending" && String(facts.stage ?? "").trim().toLowerCase() === "in progress") return false;
  return facts.application != null;
}

/* ------------------------------ what is shown ----------------------------- */

/** One rating as a manager reads it. No rater, workspace, address or id of the other side - an allowlist, never a spread. */
export type ManagerFacingRating = {
  stars: number;
  review: string;
  /** "March 2026" */
  monthYear: string;
  /** The house city only, when the property has one. */
  city: string | null;
  response: string | null;
  disputed: boolean;
  /** This manager's own workspace wrote it (the Rate sheet edits it). */
  own: boolean;
};

export type RatingSummary = { average: number | null; count: number };

export type ManagerRatingsView = {
  /** False when this record may not show ratings (not a submitted application, not a real residency, no account). */
  available: boolean;
  summary: RatingSummary;
  ratings: ManagerFacingRating[];
  /** This workspace's own rating of this stay, for the Rate sheet. */
  own: { stars: number; review: string } | null;
  canRate: boolean;
  rateRefusal: string | null;
};

export function formatRatingMonthYear(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(date);
}

export function isRatingDisputed(row: Pick<ResidentRatingRow, "disputed_at" | "dispute_resolved_at">): boolean {
  return Boolean(row.disputed_at) && !row.dispute_resolved_at;
}

export function summarizeRatings(rows: ReadonlyArray<Pick<ResidentRatingRow, "stars">>): RatingSummary {
  if (rows.length === 0) return { average: null, count: 0 };
  const total = rows.reduce((sum, row) => sum + row.stars, 0);
  return { average: Math.round((total / rows.length) * 10) / 10, count: rows.length };
}

export function toManagerFacingRating(
  row: ResidentRatingRow,
  context: { viewerWorkspaceId: string | null },
): ManagerFacingRating {
  return {
    stars: row.stars,
    review: row.review,
    monthYear: formatRatingMonthYear(row.created_at),
    city: row.house_city?.trim() || null,
    response: row.resident_response?.trim() ? row.resident_response : null,
    disputed: isRatingDisputed(row),
    own: Boolean(context.viewerWorkspaceId) && row.workspace_id === context.viewerWorkspaceId,
  };
}

/** What the resident reads about their own rating: the same facts plus the id they respond to and dispute by. */
export type ResidentFacingRating = {
  id: string;
  stars: number;
  review: string;
  monthYear: string;
  city: string | null;
  response: string | null;
  disputed: boolean;
};

export function toResidentFacingRating(row: ResidentRatingRow): ResidentFacingRating {
  return {
    id: row.id,
    stars: row.stars,
    review: row.review,
    monthYear: formatRatingMonthYear(row.created_at),
    city: row.house_city?.trim() || null,
    response: row.resident_response?.trim() ? row.resident_response : null,
    disputed: isRatingDisputed(row),
  };
}
