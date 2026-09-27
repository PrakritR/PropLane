"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { VendorReviewStarDisplay } from "@/components/portal/vendor-review-stars";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { formatVendorReviewAggregate, VENDOR_REVIEW_BODY_MAX_LENGTH, type PublicVendorReview, type VendorReviewAggregate } from "@/lib/vendor-reviews";
import { safeFormatDateTime } from "@/lib/pacific-time";

/**
 * C263 asked for a workspace filter too, but `/api/vendor/reviews` never
 * returns which workspace left a review — `reviewerLabel` is hardcoded to
 * "A PropLane manager" everywhere in `mapPublicVendorReviewRow`
 * (`src/lib/vendor-reviews.ts`) specifically so a vendor can never learn
 * which manager/workspace reviewed them. Filtering by workspace would need
 * exposing that identity to the vendor, which reverses a deliberate privacy
 * decision — so only the rating filter is built here; the workspace half is
 * intentionally not implemented (flagged, not silently built around).
 */
const RATING_FILTER_OPTIONS = [
  { value: "all", label: "All ratings" },
  { value: "5", label: "5 stars" },
  { value: "4", label: "4 stars & up" },
  { value: "3", label: "3 stars & up" },
  { value: "2", label: "2 stars & up" },
  { value: "1", label: "1 star & up" },
] as const;
type RatingFilterValue = (typeof RATING_FILTER_OPTIONS)[number]["value"];

/** The vendor reply is one-shot: once sent it renders read-only, no edit affordance (C157). */
function ReviewReplyForm({ review, onReplied }: { review: PublicVendorReview; onReplied: (next: PublicVendorReview) => void }) {
  const { showToast } = useAppUi();
  const [reply, setReply] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!reply.trim()) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/vendor/reviews/${review.id}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reply }),
      });
      const data = (await res.json()) as { review?: PublicVendorReview; error?: string };
      if (!res.ok || !data.review) {
        showToast?.(data.error || "Could not save the reply.");
        return;
      }
      onReplied(data.review);
      showToast?.("Reply sent.");
    } finally {
      setSaving(false);
    }
  };

  if (review.vendorReply) {
    return (
      <div className="rounded-lg bg-muted/10 px-2.5 py-1.5 text-[13px]">
        <p className="text-muted">
          <span className="font-medium text-foreground">Your reply: </span>
          {review.vendorReply}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <textarea
        value={reply}
        onChange={(e) => setReply(e.target.value.slice(0, VENDOR_REVIEW_BODY_MAX_LENGTH))}
        rows={2}
        className="w-full rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground outline-none transition focus:ring-2 focus:ring-primary/25"
        placeholder="Reply to this review…"
        data-attr="vendor-review-reply-input"
      />
      <Button
        type="button"
        variant="primary"
        onClick={() => submit()}
        disabled={saving || !reply.trim()}
        data-attr="vendor-review-reply-save"
      >
        {saving ? "Sending…" : "Send reply"}
      </Button>
    </div>
  );
}

/** Vendor Reviews — every review left on the vendor's completed services, with one editable reply each. */
export function VendorReviewsPanel() {
  const [reviews, setReviews] = useState<PublicVendorReview[] | null>(null);
  const [aggregate, setAggregate] = useState<VendorReviewAggregate>({ average: null, count: 0 });
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [ratingFilter, setRatingFilter] = useState<RatingFilterValue>("all");

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    fetch("/api/vendor/reviews")
      .then((res) => res.json())
      .then((data: { reviews?: PublicVendorReview[]; aggregate?: VendorReviewAggregate; error?: string }) => {
        if (cancelled) return;
        if (data.error) {
          setState("error");
          return;
        }
        setReviews(data.reviews ?? []);
        setAggregate(data.aggregate ?? { average: null, count: 0 });
        setState("ready");
      })
      .catch(() => {
        if (!cancelled) setState("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const minStars = ratingFilter === "all" ? null : Number(ratingFilter);
  const filteredReviews = useMemo(
    () => (reviews && minStars != null ? reviews.filter((review) => review.stars >= minStars) : reviews),
    [reviews, minStars],
  );

  return (
    <ManagerPortalPageShell title="Reviews" hideTitleOnMobileNav compactFilterRow>
      <div className="space-y-3 px-3 pb-6 sm:px-4" data-attr="vendor-reviews-panel">
        <div className="flex items-center justify-between rounded-xl border border-border bg-card px-3.5 py-2.5">
          <span className="text-sm font-medium">Overall</span>
          <span className="text-sm text-muted">{state === "ready" ? formatVendorReviewAggregate(aggregate) : "—"}</span>
        </div>
        {reviews && reviews.length > 0 ? (
          <PortalListControlStack
            variant="command"
            filterRow={
              <div className="flex items-center gap-2 text-xs font-semibold text-muted">
                Rating
                <FieldSingleSelect
                  label="Filter by rating"
                  hideLabel
                  value={ratingFilter}
                  onChange={(next) => setRatingFilter(next as RatingFilterValue)}
                  options={[...RATING_FILTER_OPTIONS]}
                  variant="pill"
                  dataAttr="vendor-reviews-rating-filter"
                />
              </div>
            }
          />
        ) : null}
        {state === "loading" ? (
          <p className="py-10 text-center text-sm">Loading reviews…</p>
        ) : state === "error" ? (
          <p className="py-10 text-center text-sm">Could not load reviews.</p>
        ) : !reviews || reviews.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted">No reviews yet.</p>
        ) : !filteredReviews || filteredReviews.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted">No reviews match this rating.</p>
        ) : (
          <ul className="space-y-2.5">
            {filteredReviews.map((review) => (
              <li key={review.id} className="space-y-2 rounded-xl border border-border bg-card p-3.5" data-attr="vendor-review-row">
                <div className="flex items-center justify-between gap-2">
                  <VendorReviewStarDisplay stars={review.stars} size="md" />
                  <span className="text-[12.5px] text-muted">{safeFormatDateTime(review.createdAt)}</span>
                </div>
                {review.body ? <p className="text-sm">{review.body}</p> : null}
                <ReviewReplyForm
                  review={review}
                  onReplied={(next) =>
                    setReviews((prev) => (prev ? prev.map((r) => (r.id === next.id ? next : r)) : prev))
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </ManagerPortalPageShell>
  );
}
