/**
 * Vendor review shared types + pure helpers, used by the manager `Leave a
 * review` dialog, the vendor Reviews panel, and the `/api/portal/vendor-reviews`
 * + `/api/vendor/reviews` routes. Eligibility, the edit window, the aggregate,
 * and cross-workspace redaction are all pure functions here so they're unit
 * testable without a database — the routes re-derive everything server-side
 * from rows they fetch themselves, never from the request body.
 */

export type VendorReview = {
  id: string;
  managerUserId: string;
  vendorUserId: string;
  workOrderId: string;
  stars: number;
  body: string;
  vendorReply: string | null;
  vendorRepliedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Columns selected from `vendor_reviews` for API reads. */
export const VENDOR_REVIEW_SELECT =
  "id, manager_user_id, reviewer_user_id, vendor_user_id, work_order_id, stars, body, vendor_reply, vendor_replied_at, created_at, updated_at";

export function mapVendorReviewRow(row: Record<string, unknown>): VendorReview {
  return {
    id: String(row.id),
    managerUserId: String(row.manager_user_id ?? ""),
    vendorUserId: String(row.vendor_user_id ?? ""),
    workOrderId: String(row.work_order_id ?? ""),
    stars: Number(row.stars ?? 0),
    body: String(row.body ?? ""),
    vendorReply: (row.vendor_reply as string | null) ?? null,
    vendorRepliedAt: (row.vendor_replied_at as string | null) ?? null,
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
}

/**
 * The vendor-safe projection: never a `*_user_id` or `work_order_id` column,
 * even though the vendor route reads via the service-role client. RLS on
 * `vendor_reviews` grants no direct client SELECT at all (see
 * `20260925010000_vendor_reviews_no_client_select.sql`) — this is the belt
 * *and* the suspenders: even a route that queries too much would still have
 * to explicitly choose to return these fields to leak an identity.
 */
export const VENDOR_REVIEW_PUBLIC_SELECT = "id, stars, body, vendor_reply, vendor_replied_at, created_at, updated_at";

export type PublicVendorReview = {
  id: string;
  stars: number;
  body: string;
  vendorReply: string | null;
  vendorRepliedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Always "A PropLane manager" — a vendor never learns which manager/workspace reviewed them. */
  reviewerLabel: string;
};

export function mapPublicVendorReviewRow(row: Record<string, unknown>): PublicVendorReview {
  return {
    id: String(row.id),
    stars: Number(row.stars ?? 0),
    body: String(row.body ?? ""),
    vendorReply: (row.vendor_reply as string | null) ?? null,
    vendorRepliedAt: (row.vendor_replied_at as string | null) ?? null,
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
    reviewerLabel: "A PropLane manager",
  };
}

export const VENDOR_REVIEW_BODY_MAX_LENGTH = 2000;

export function normalizeVendorReviewStars(raw: unknown): number | null {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n) || n < 1 || n > 5) return null;
  return n;
}

export function normalizeVendorReviewBody(raw: unknown): string {
  return String(raw ?? "").trim().slice(0, VENDOR_REVIEW_BODY_MAX_LENGTH);
}

/**
 * C158: a posted review can never be edited, regardless of age. Kept as a
 * function (rather than deleted outright) so every call site — the API route
 * and the dialog — keeps one single source of truth to refuse from, instead
 * of each hand-rolling its own "never" check.
 */
export function canEditVendorReview(_createdAt: string, _now?: Date): boolean {
  void _now;
  return false;
}

export type VendorReviewEligibilityInput = {
  /** `row_data.bucket` on the target `portal_work_order_records` row. */
  workOrderBucket: string | null | undefined;
  /** `manager_user_id` column on the target work order row. */
  workOrderManagerUserId: string | null | undefined;
  /** `vendor_user_id` column on the target work order row. */
  workOrderVendorUserId: string | null | undefined;
  /** The server-resolved manager id of the actor making the request. */
  actorManagerUserId: string;
};

export type VendorReviewEligibilityResult =
  | { ok: true; vendorUserId: string }
  | { ok: false; status: 400 | 403 | 404; error: string };

/**
 * Re-derives whether a manager may review a given work order, purely from
 * already-fetched row data — never from client-supplied ids or flags. Used by
 * both the create route (before insert) and its own unit tests.
 */
export function evaluateVendorReviewEligibility(
  input: VendorReviewEligibilityInput,
): VendorReviewEligibilityResult {
  if (!input.workOrderManagerUserId) {
    return { ok: false, status: 404, error: "Service not found." };
  }
  if (input.workOrderManagerUserId !== input.actorManagerUserId) {
    return { ok: false, status: 403, error: "This service belongs to a different workspace." };
  }
  if (input.workOrderBucket !== "completed") {
    return { ok: false, status: 400, error: "Only a completed service can be reviewed." };
  }
  if (!input.workOrderVendorUserId) {
    return { ok: false, status: 400, error: "No vendor is linked to this service yet." };
  }
  return { ok: true, vendorUserId: input.workOrderVendorUserId };
}

export type VendorReviewAggregate = { average: number | null; count: number };

/** Average rounded to one decimal (e.g. 4.6), never invented for zero reviews. */
export function computeVendorReviewAggregate(stars: readonly number[]): VendorReviewAggregate {
  if (stars.length === 0) return { average: null, count: 0 };
  const sum = stars.reduce((acc, n) => acc + n, 0);
  return { average: Math.round((sum / stars.length) * 10) / 10, count: stars.length };
}

export function formatVendorReviewAggregate(agg: VendorReviewAggregate): string {
  if (agg.count === 0 || agg.average == null) return "No reviews yet";
  return `★ ${agg.average.toFixed(1)} · ${agg.count}`;
}

/**
 * The manager-facing reviewer identity for a vendor's cross-workspace review
 * list: the viewer's own workspace's reviews show plainly, every other
 * workspace's review is redacted to a generic label so one manager can never
 * learn which other landlord/workspace hired the same vendor.
 */
export function vendorReviewWorkspaceLabel(
  reviewManagerUserId: string,
  viewerManagerUserId: string | null,
): string {
  if (viewerManagerUserId && reviewManagerUserId === viewerManagerUserId) return "Your workspace";
  return "A PropLane manager";
}

/** Strips the manager identity from a review shown to a different workspace. */
export function redactVendorReviewForViewer<T extends { managerUserId: string }>(
  review: T,
  viewerManagerUserId: string | null,
): T & { reviewerLabel: string; isOwnWorkspace: boolean } {
  const isOwnWorkspace = Boolean(viewerManagerUserId && review.managerUserId === viewerManagerUserId);
  return {
    ...review,
    reviewerLabel: vendorReviewWorkspaceLabel(review.managerUserId, viewerManagerUserId),
    isOwnWorkspace,
    // Never leak the raw manager id to a viewer outside that workspace.
    managerUserId: isOwnWorkspace ? review.managerUserId : "",
  };
}
