"use client";

import { useEffect, useMemo, useState } from "react";
import { CalendarDays, Check } from "lucide-react";
import { Zap } from "lucide-react";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { Input, Textarea } from "@/components/ui/input";
import { MODAL_FIELD_LABEL_CLASS } from "@/components/ui/modal";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalPropertyRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";
import { QuickReplyList } from "@/components/portal/quick-reply-menu";
import { VendorRowMenu } from "@/components/portal/vendor-row-menu";
import { VendorSettingsGear } from "@/components/portal/vendor-settings-gear";
import { insertQuickReplyText } from "@/lib/vendor-quick-replies";
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
import { VENDOR_REVIEW_BODY_MAX_LENGTH, type PublicVendorReview } from "@/lib/vendor-reviews";
import { Button } from "@/components/ui/button";


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

function formatReviewDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** "★ 4.7 · 3 reviews" — every figure derived from the rows on screen. */
export function reviewsSummary(reviews: PublicVendorReview[] | null): string | null {
  if (!reviews || reviews.length === 0) return null;
  const average = reviews.reduce((sum, r) => sum + r.stars, 0) / reviews.length;
  return `★ ${average.toFixed(1)} · ${reviews.length} ${reviews.length === 1 ? "review" : "reviews"}`;
}

/**
 * The reply pop-up: the review for context, the reply field with the vendor's
 * quick replies (⚡ inserts one, still editable), Save in the footer. A first
 * reply is a POST; changing one already sent is a PATCH.
 */
function ReviewReplyDialog({
  review,
  openQuickReplies,
  onClose,
  onReplied,
}: {
  review: PublicVendorReview;
  openQuickReplies: boolean;
  onClose: () => void;
  onReplied: (next: PublicVendorReview) => void;
}) {
  const { showToast } = useAppUi();
  const editing = Boolean(review.vendorReply);
  const [reply, setReply] = useState(review.vendorReply ?? "");
  const [saving, setSaving] = useState(false);
  // "Reply with a quick reply" opens with the list already showing.
  const [showReplies, setShowReplies] = useState(openQuickReplies);

  const submit = async () => {
    if (!reply.trim()) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/vendor/reviews/${review.id}/reply`, {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reply }),
      });
      const data = (await res.json().catch(() => ({}))) as { review?: PublicVendorReview; error?: string };
      if (!res.ok || !data.review) {
        showToast?.(data.error || "Could not save the reply.");
        return;
      }
      onReplied(data.review);
      showToast?.(editing ? "Reply updated." : "Reply sent.");
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <PortalDialog
      open
      onClose={onClose}
      title={editing ? "Edit reply" : "Reply to review"}
      dataAttr="vendor-review-reply-dialog"
      primaryAction={{
        label: "Save reply",
        onClick: () => submit(),
        disabled: saving || !reply.trim(),
        loading: saving,
        dataAttr: "vendor-review-reply-save",
      }}
    >
      <div className="space-y-4">
        <div className="rounded-xl border border-border bg-muted/10 px-3.5 py-3" data-attr="vendor-review-reply-context">
          <VendorReviewStarDisplay stars={review.stars} size="md" />
          {review.body ? <p className="mt-1.5 text-sm text-foreground">{review.body}</p> : null}
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor="vendor-review-reply-input" className={MODAL_FIELD_LABEL_CLASS}>
              Your reply
            </label>
            <PortalIconAction
              icon={Zap}
              label="Quick replies"
              active={showReplies}
              data-attr="vendor-review-quick-replies"
              onClick={() => setShowReplies((v) => !v)}
            />
          </div>
          {showReplies ? (
            <QuickReplyList
              dataAttr="vendor-review-quick-replies-list"
              onPick={(text) => {
                setReply((draft) => insertQuickReplyText(draft, text, VENDOR_REVIEW_BODY_MAX_LENGTH));
                setShowReplies(false);
              }}
            />
          ) : null}
          <Textarea
            id="vendor-review-reply-input"
            rows={4}
            value={reply}
            onChange={(e) => setReply(e.target.value.slice(0, VENDOR_REVIEW_BODY_MAX_LENGTH))}
            data-attr="vendor-review-reply-input"
          />
        </div>
      </div>
    </PortalDialog>
  );
}

/**
 * Vendor Reviews — ONE list of every review left on the vendor's completed services, newest first
 * (vendor-portal-ia-1007, D4: no tabs, no stat cards). The header line carries the average and the
 * count as plain facts; search and the Filter icon narrow the list. A review with no reply offers
 * Reply in its ⋯, a replied one offers Edit reply, one editable reply each.
 */
export function VendorReviewsPanel({ basePath = "/vendor" }: { basePath?: string }) {
  const [reviews, setReviews] = useState<PublicVendorReview[] | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [loadTick, setLoadTick] = useState(0);
  const [ratingFilter, setRatingFilter] = useState<RatingFilterValue>("0");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [search, setSearch] = useState("");
  const [replying, setReplying] = useState<{ review: PublicVendorReview; quick: boolean } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    fetch("/api/vendor/reviews", { credentials: "include" })
      .then(async (res) => {
        // A 401 / 403 / 500 is a failed load, not "no reviews": say so and offer Try again.
        const data = (await res.json().catch(() => ({}))) as { reviews?: PublicVendorReview[]; error?: string };
        if (cancelled) return;
        if (!res.ok || data.error || !Array.isArray(data.reviews)) {
          setState("error");
          return;
        }
        setReviews([...data.reviews].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
        setState("ready");
      })
      .catch(() => {
        if (!cancelled) setState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [loadTick]);

  const byTab = reviews;

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

  const openReply = (review: PublicVendorReview, quick: boolean) => setReplying({ review, quick });

  return (
    <ManagerPortalPageShell title="Reviews" hideTitleOnMobileNav compactFilterRow>
      <PortalListControlStack
        className="mb-2 max-lg:mb-1.5"
        variant="command"
        search={{
          value: search,
          onChange: setSearch,
          placeholder: "Search reviews",
          dataAttr: "vendor-reviews-search",
        }}
        recordSummary={state === "ready" ? reviewsSummary(reviews) : null}
        actions={
          <>
            {filterSheet}
            <VendorSettingsGear section="reviews" label="Profile settings" basePath={basePath} />
          </>
        }
      />
      <div className="px-3 pb-6 sm:px-4" data-attr="vendor-reviews-panel">
        {state === "loading" ? (
          <p className="py-10 text-center text-sm">Loading reviews…</p>
        ) : state === "error" ? (
          <div className="flex flex-col items-center gap-3 py-10 text-center" data-attr="vendor-reviews-error">
            <p className="text-sm font-semibold text-foreground">Could not load reviews.</p>
            <Button type="button" variant="outline" data-attr="vendor-reviews-retry" onClick={() => setLoadTick((n) => n + 1)}>
              Try again
            </Button>
          </div>
        ) : (
          <PortalRecordListSurface
            isEmpty={!filteredReviews || filteredReviews.length === 0}
            emptyCard={{
              title: !reviews || reviews.length === 0 ? "No reviews yet" : "No reviews match these filters",
              section: "reviews",
              tone: "muted",
            }}
            dataAttr="vendor-reviews-list"
          >
            {(filteredReviews ?? []).map((review) => {
              const replied = Boolean(review.vendorReply);
              return (
                <PortalPropertyRecordRow
                  key={review.id}
                  title={review.reviewerLabel}
                  address={review.body || undefined}
                  facts={
                    <>
                      <PortalRowFact icon={CalendarDays} srLabel="Reviewed">
                        {formatReviewDate(review.createdAt)}
                      </PortalRowFact>
                      {replied ? (
                        <PortalRowFact icon={Check} srLabel="Replied">
                          Replied
                        </PortalRowFact>
                      ) : null}
                    </>
                  }
                  leading={
                    <span
                      className="flex size-14 items-center justify-center rounded-xl bg-accent text-[15px] font-bold text-primary"
                      aria-hidden
                    >
                      {Math.round(review.stars)}★
                    </span>
                  }
                  leadingShape="square"
                  onOpen={() => openReply(review, false)}
                  dataAttr="vendor-review-row"
                  actions={
                    <VendorRowMenu
                      label={review.reviewerLabel}
                      dataAttr="vendor-review-menu"
                      items={
                        replied
                          ? [{ id: "edit-reply", label: "Edit reply", onSelect: () => openReply(review, false) }]
                          : [
                              { id: "reply", label: "Reply", onSelect: () => openReply(review, false) },
                              {
                                id: "reply-quick",
                                label: "Reply with a quick reply",
                                onSelect: () => openReply(review, true),
                              },
                            ]
                      }
                    />
                  }
                />
              );
            })}
          </PortalRecordListSurface>
        )}
      </div>
      {replying ? (
        <ReviewReplyDialog
          key={`${replying.review.id}-${replying.quick}`}
          review={replying.review}
          openQuickReplies={replying.quick}
          onClose={() => setReplying(null)}
          onReplied={(next) => setReviews((prev) => (prev ? prev.map((r) => (r.id === next.id ? next : r)) : prev))}
        />
      ) : null}
    </ManagerPortalPageShell>
  );
}
