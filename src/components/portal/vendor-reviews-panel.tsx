"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { VendorReviewStarDisplay } from "@/components/portal/vendor-review-stars";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { formatVendorReviewAggregate, VENDOR_REVIEW_BODY_MAX_LENGTH, type VendorReview, type VendorReviewAggregate } from "@/lib/vendor-reviews";
import { safeFormatDateTime } from "@/lib/pacific-time";

function ReviewReplyForm({ review, onReplied }: { review: VendorReview; onReplied: (next: VendorReview) => void }) {
  const { showToast } = useAppUi();
  const [reply, setReply] = useState(review.vendorReply ?? "");
  const [editing, setEditing] = useState(!review.vendorReply);
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
      const data = (await res.json()) as { review?: VendorReview; error?: string };
      if (!res.ok || !data.review) {
        showToast?.(data.error || "Could not save the reply.");
        return;
      }
      onReplied(data.review);
      setEditing(false);
      showToast?.("Reply sent.");
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <div className="rounded-lg bg-muted/10 px-2.5 py-1.5 text-[13px]">
        <p className="text-muted">
          <span className="font-medium text-foreground">Your reply: </span>
          {review.vendorReply}
        </p>
        <button
          type="button"
          className="mt-1 text-[12.5px] font-medium text-primary"
          onClick={() => setEditing(true)}
          data-attr="vendor-review-reply-edit"
        >
          Edit reply
        </button>
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
  const [reviews, setReviews] = useState<VendorReview[] | null>(null);
  const [aggregate, setAggregate] = useState<VendorReviewAggregate>({ average: null, count: 0 });
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    fetch("/api/vendor/reviews")
      .then((res) => res.json())
      .then((data: { reviews?: VendorReview[]; aggregate?: VendorReviewAggregate; error?: string }) => {
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

  return (
    <ManagerPortalPageShell title="Reviews" hideTitleOnMobileNav compactFilterRow>
      <div className="space-y-3 px-3 pb-6 sm:px-4" data-attr="vendor-reviews-panel">
        <div className="flex items-center justify-between rounded-xl border border-border bg-card px-3.5 py-2.5">
          <span className="text-sm font-medium">Overall</span>
          <span className="text-sm text-muted">{state === "ready" ? formatVendorReviewAggregate(aggregate) : "—"}</span>
        </div>
        {state === "loading" ? (
          <p className="py-10 text-center text-sm">Loading reviews…</p>
        ) : state === "error" ? (
          <p className="py-10 text-center text-sm">Could not load reviews.</p>
        ) : !reviews || reviews.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted">No reviews yet.</p>
        ) : (
          <ul className="space-y-2.5">
            {reviews.map((review) => (
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
