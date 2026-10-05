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
 * `20260925020000_vendor_reviews_no_client_select.sql`) — this is the belt
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

/**
 * The vendor Reviews top bar's sections (VD21, 2026-09-27) — a real routed
 * tab (like every other portal list), not a client-only toggle. "Needs
 * reply" / "Replied" read the real `vendorReply === null` field, never
 * invented data.
 */
export const VENDOR_REVIEW_STATUS_TABS = [
  { id: "all", label: "All" },
  { id: "needs-reply", label: "Needs reply" },
  { id: "replied", label: "Replied" },
] as const;
export type VendorReviewStatusTab = (typeof VENDOR_REVIEW_STATUS_TABS)[number]["id"];

export function isVendorReviewStatusTab(raw: string): raw is VendorReviewStatusTab {
  return (VENDOR_REVIEW_STATUS_TABS as readonly { id: string }[]).some((t) => t.id === raw);
}

export function normalizeVendorReviewStars(raw: unknown): number | null {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n) || n < 1 || n > 5) return null;
  return n;
}

export function normalizeVendorReviewBody(raw: unknown): string {
  return String(raw ?? "").trim().slice(0, VENDOR_REVIEW_BODY_MAX_LENGTH);
}

/** How long the reviewer may still change their own review, in days. */
export const VENDOR_REVIEW_EDIT_WINDOW_DAYS = 14;

const VENDOR_REVIEW_EDIT_WINDOW_MS = VENDOR_REVIEW_EDIT_WINDOW_DAYS * 86_400_000;

/**
 * The reviewer may change their own review for fourteen days. One source of that decision for the
 * PATCH route, the dialog and the Edit review menu item; an unreadable `created_at` fails closed.
 */
export function canEditVendorReview(createdAt: string, now = new Date()): boolean {
  const created = new Date(createdAt).getTime();
  if (!Number.isFinite(created)) return false;
  return now.getTime() - created <= VENDOR_REVIEW_EDIT_WINDOW_MS;
}

/** The `created_at` floor the PATCH update filter uses, so the window is enforced in the database too. */
export function vendorReviewEditWindowFloorIso(now = new Date()): string {
  return new Date(now.getTime() - VENDOR_REVIEW_EDIT_WINDOW_MS).toISOString();
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
  /** True when the assigned vendor has given an estimate (see {@link vendorHasGivenEstimate}); re-derived from rows, never the request. */
  estimateGiven?: boolean;
  /** The vendor the caller says it is reviewing; when set it must be the vendor on the service. */
  expectedVendorUserId?: string | null;
};

/**
 * "At least an estimate was given": the vendor submitted a bid on the service (any status —
 * a declined bid is still an estimate they gave), or set their price on it
 * (`row_data.vendorCostCents` / `vendorPriceSetAt`). Pure so the route and the Services
 * summary read the same rule.
 */
export function vendorHasGivenEstimate(input: {
  bidCount?: number | null;
  vendorCostCents?: unknown;
  vendorPriceSetAt?: unknown;
}): boolean {
  if ((input.bidCount ?? 0) > 0) return true;
  if (typeof input.vendorPriceSetAt === "string" && input.vendorPriceSetAt.trim()) return true;
  return typeof input.vendorCostCents === "number" && Number.isFinite(input.vendorCostCents) && input.vendorCostCents > 0;
}

/** A service can be picked in the Add review dialog: finished, or at least estimated. */
export function isVendorReviewableService(input: { completed: boolean; estimateGiven: boolean }): boolean {
  return input.completed || input.estimateGiven;
}

export type VendorReviewEligibilityResult =
  | { ok: true; vendorUserId: string }
  | { ok: false; status: 400 | 403 | 404 | 422; error: string };

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
  if (!input.workOrderVendorUserId) {
    return { ok: false, status: 400, error: "No vendor is linked to this service yet." };
  }
  if (input.expectedVendorUserId && input.expectedVendorUserId !== input.workOrderVendorUserId) {
    return { ok: false, status: 403, error: "This service belongs to a different vendor." };
  }
  if (!isVendorReviewableService({ completed: input.workOrderBucket === "completed", estimateGiven: input.estimateGiven === true })) {
    return { ok: false, status: 422, error: "A service can be reviewed once it is completed or the vendor has given an estimate." };
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
