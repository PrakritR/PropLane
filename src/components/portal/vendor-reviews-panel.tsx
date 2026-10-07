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
import {
  VENDOR_REVIEW_BODY_MAX_LENGTH,
  VENDOR_REVIEW_STATUS_TABS,
  type PublicVendorReview,
  type VendorReviewStatusTab,
} from "@/lib/vendor-reviews";


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

/** The header stats strip: Average rating, Reviews, Needs reply, Response rate — every figure derived from the rows. */
function ReviewStatsStrip({ reviews, loading }: { reviews: PublicVendorReview[] | null; loading: boolean }) {
  const total = reviews?.length ?? 0;
  const needsReply = reviews?.filter((r) => !r.vendorReply).length ?? 0;
  const average = total > 0 ? reviews!.reduce((sum, r) => sum + r.stars, 0) / total : null;
  const responseRate = total > 0 ? Math.round(((total - needsReply) / total) * 100) : null;
  const cells: { id: string; label: string; value: string }[] = [
    { id: "average", label: "Average rating", value: loading || average == null ? "—" : `${average.toFixed(1)} ★` },
    { id: "count", label: "Reviews", value: loading ? "—" : String(total) },
    { id: "needs-reply", label: "Needs reply", value: loading ? "—" : String(needsReply) },
    { id: "response-rate", label: "Response rate", value: loading || responseRate == null ? "—" : `${responseRate}%` },
  ];
  return (
    <div
      className="mb-3 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-4"
      data-attr="vendor-reviews-stats"
    >
      {cells.map((cell) => (
        <div key={cell.id} className="bg-card px-4 py-3" data-attr={`vendor-reviews-stat-${cell.id}`}>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">{cell.label}</p>
          <p className="mt-1 text-xl font-extrabold leading-none tracking-tight text-foreground">{cell.value}</p>
        </div>
      ))}
    </div>
  );
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
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [ratingFilter, setRatingFilter] = useState<RatingFilterValue>("0");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [search, setSearch] = useState("");
  const [replying, setReplying] = useState<{ review: PublicVendorReview; quick: boolean } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    fetch("/api/vendor/reviews")
      .then((res) => res.json())
      .then((data: { reviews?: PublicVendorReview[]; error?: string }) => {
        if (cancelled) return;
        if (data.error) {
          setState("error");
          return;
        }
        setReviews(data.reviews ?? []);
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

  const openReply = (review: PublicVendorReview, quick: boolean) => setReplying({ review, quick });

  return (
    <ManagerPortalPageShell title="Reviews" hideTitleOnMobileNav compactFilterRow>
      {/* The stats card stays above the tabs bar whichever tab is selected, like the balance card on Payments. */}
      <div className="px-3 sm:px-4">
        <ReviewStatsStrip reviews={reviews} loading={state === "loading"} />
      </div>
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
          <p className="py-10 text-center text-sm">Could not load reviews.</p>
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
