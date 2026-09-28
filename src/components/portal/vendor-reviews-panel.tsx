"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalFilterSortSheet, portalFilterActiveCount } from "@/components/portal/portal-filter-sort-sheet";
import {
  FilterCollapsibleSection,
  FilterFieldsAccordion,
  FilterSingleSelectList,
  filterSingleSelectSummary,
} from "@/components/portal/filter-field-lists";
import { VendorReviewStarDisplay } from "@/components/portal/vendor-review-stars";
import { useAppUi } from "@/components/providers/app-ui-provider";
import {
  formatVendorReviewAggregate,
  VENDOR_REVIEW_BODY_MAX_LENGTH,
  VENDOR_REVIEW_STATUS_TABS,
  type PublicVendorReview,
  type VendorReviewAggregate,
  type VendorReviewStatusTab,
} from "@/lib/vendor-reviews";
import { safeFormatDateTime } from "@/lib/pacific-time";

/**
 * C263 asked for a workspace filter too, but `/api/vendor/reviews` never
 * returns which workspace left a review, or a property/work-order link —
 * `reviewerLabel` is hardcoded to "A PropLane manager" everywhere in
 * `mapPublicVendorReviewRow` (`src/lib/vendor-reviews.ts`) specifically so a
 * vendor can never learn which manager/workspace reviewed them. A Property
 * filter (VD21's studio spec) would need exposing that same work-order/
 * property link, which reverses that deliberate redaction — so VD21 ships
 * with Rating + Date only; Property is intentionally not built (flagged,
 * not silently built around).
 */
const RATING_FILTER_OPTIONS = [
  { value: "0", label: "All ratings" },
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

/** The 5★→1★ distribution bars under the Overall summary (VD21, 2026-09-27). */
function OverallDistribution({ reviews }: { reviews: PublicVendorReview[] }) {
  const dist = useMemo(() => {
    const counts = [5, 4, 3, 2, 1].map((n) => ({
      n,
      count: reviews.filter((r) => Math.round(r.stars) === n).length,
    }));
    const maxCount = Math.max(1, ...counts.map((d) => d.count));
    return counts.map((d) => ({ ...d, pct: Math.round((d.count / maxCount) * 100) }));
  }, [reviews]);

  if (reviews.length === 0) return null;

  return (
    <div className="mt-2.5 space-y-1" data-attr="vendor-reviews-distribution">
      {dist.map((d) => (
        <div key={d.n} className="flex items-center gap-2 text-xs text-muted">
          <span className="w-6 shrink-0">{d.n}★</span>
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary/60">
            <span className="block h-full rounded-full bg-primary" style={{ width: `${d.pct}%` }} />
          </div>
          <span className="w-4 shrink-0 text-right">{d.count}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Vendor Reviews — a Services-style top bar (sections, search, Filter) over
 * every review left on the vendor's completed services, with one editable
 * reply each (VD21, 2026-09-27).
 */
export function VendorReviewsPanel({
  tabId = "all",
  basePath = "/vendor",
}: {
  tabId?: VendorReviewStatusTab;
  basePath?: string;
}) {
  const [reviews, setReviews] = useState<PublicVendorReview[] | null>(null);
  const [aggregate, setAggregate] = useState<VendorReviewAggregate>({ average: null, count: 0 });
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [ratingFilter, setRatingFilter] = useState<RatingFilterValue>("0");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [search, setSearch] = useState("");

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

  const byTab = useMemo(() => {
    if (!reviews) return null;
    if (tabId === "needs-reply") return reviews.filter((r) => !r.vendorReply);
    if (tabId === "replied") return reviews.filter((r) => Boolean(r.vendorReply));
    return reviews;
  }, [reviews, tabId]);

  const tabCounts = useMemo(() => {
    const all = reviews?.length ?? 0;
    const needsReply = reviews?.filter((r) => !r.vendorReply).length ?? 0;
    return { all, "needs-reply": needsReply, replied: all - needsReply };
  }, [reviews]);

  const minStars = ratingFilter === "0" ? null : Number(ratingFilter);
  const needle = search.trim().toLowerCase();
  const filteredReviews = useMemo(() => {
    if (!byTab) return byTab;
    return byTab.filter((review) => {
      if (minStars != null && review.stars < minStars) return false;
      if (fromDate && review.createdAt < fromDate) return false;
      if (toDate && review.createdAt > `${toDate}T23:59:59`) return false;
      if (needle && !review.body.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [byTab, minStars, fromDate, toDate, needle]);

  const filterActiveCount = portalFilterActiveCount([ratingFilter !== "0" ? ratingFilter : "", fromDate, toDate]);

  const filterSheet = (
    <PortalFilterSortSheet
      activeCount={filterActiveCount}
      compactPanel
      filterFieldCount={3}
      commandStripTrigger
      onReset={() => {
        setRatingFilter("0");
        setFromDate("");
        setToDate("");
      }}
      dataAttr="vendor-reviews-filter-open"
    >
      <FilterFieldsAccordion>
        <FilterCollapsibleSection
          sectionId="rating"
          label="Rating"
          summary={filterSingleSelectSummary(ratingFilter, [...RATING_FILTER_OPTIONS], "All ratings")}
          empty={ratingFilter === "0"}
          menuOptionCount={RATING_FILTER_OPTIONS.length}
          dataAttr="vendor-reviews-filter-rating"
        >
          <FilterSingleSelectList
            options={[...RATING_FILTER_OPTIONS]}
            value={ratingFilter}
            onChange={(next) => setRatingFilter(next as RatingFilterValue)}
            dataAttr="vendor-reviews-rating"
          />
        </FilterCollapsibleSection>
        <FilterCollapsibleSection sectionId="from" label="From" summary={fromDate || "Any"} empty={!fromDate} menuOptionCount={1}>
          <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} data-attr="vendor-reviews-filter-from" />
        </FilterCollapsibleSection>
        <FilterCollapsibleSection sectionId="to" label="To" summary={toDate || "Any"} empty={!toDate} menuOptionCount={1}>
          <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} data-attr="vendor-reviews-filter-to" />
        </FilterCollapsibleSection>
      </FilterFieldsAccordion>
    </PortalFilterSortSheet>
  );

  return (
    <ManagerPortalPageShell title="Reviews" hideTitleOnMobileNav compactFilterRow>
      <PortalListControlStack
        className="mb-2 max-lg:mb-1.5"
        variant="command"
        destinations={VENDOR_REVIEW_STATUS_TABS.map((tab) => ({
          id: tab.id,
          label: tab.label,
          count: tabCounts[tab.id],
          href: `${basePath}/reviews/${tab.id}`,
          dataAttr: `vendor-reviews-tab-${tab.id}`,
        }))}
        activeDestinationId={tabId}
        destinationAriaLabel="Review status"
        search={{
          value: search,
          onChange: setSearch,
          placeholder: "Search reviews",
          dataAttr: "vendor-reviews-search",
        }}
        actions={filterSheet}
      />
      <div className="space-y-3 px-3 pb-6 sm:px-4" data-attr="vendor-reviews-panel">
        <div className="rounded-xl border border-border bg-card px-3.5 py-2.5">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Overall</span>
            <span className="text-sm text-muted">{state === "ready" ? formatVendorReviewAggregate(aggregate) : "—"}</span>
          </div>
          {reviews ? <OverallDistribution reviews={reviews} /> : null}
        </div>
        {state === "loading" ? (
          <p className="py-10 text-center text-sm">Loading reviews…</p>
        ) : state === "error" ? (
          <p className="py-10 text-center text-sm">Could not load reviews.</p>
        ) : !reviews || reviews.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted">No reviews yet.</p>
        ) : !filteredReviews || filteredReviews.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted">No reviews match these filters.</p>
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
