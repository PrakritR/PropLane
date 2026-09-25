"use client";

import { useEffect, useState } from "react";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { VendorReviewStarPicker } from "@/components/portal/vendor-review-stars";
import { canEditVendorReview, VENDOR_REVIEW_BODY_MAX_LENGTH, type VendorReview } from "@/lib/vendor-reviews";
import { useAppUi } from "@/components/providers/app-ui-provider";

export type VendorReviewDialogRow = { id: string; title: string; vendorName?: string };

/**
 * Manager "Leave a review" / "Edit review" dialog for one completed service.
 * Loads the workspace's existing review for the work order (if any) so it
 * opens straight into edit mode within the 14-day window.
 */
export function VendorReviewDialog({
  open,
  row,
  onClose,
  onSaved,
}: {
  open: boolean;
  row: VendorReviewDialogRow | null;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const { showToast } = useAppUi();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [existing, setExisting] = useState<VendorReview | null>(null);
  const [stars, setStars] = useState(0);
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (!open || !row) {
      setExisting(null);
      setStars(0);
      setNotes("");
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetch(`/api/portal/vendor-reviews?workOrderId=${encodeURIComponent(row.id)}`)
      .then((res) => res.json())
      .then((data: { review?: VendorReview | null; error?: string }) => {
        if (cancelled) return;
        const review = data.review ?? null;
        setExisting(review);
        setStars(review?.stars ?? 0);
        setNotes(review?.body ?? "");
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, row]);

  if (!row) return null;

  const editWindowClosed = Boolean(existing && !canEditVendorReview(existing.createdAt));
  const readOnly = editWindowClosed;

  const submit = async () => {
    if (!row || stars < 1) return;
    setSaving(true);
    try {
      const url = existing ? `/api/portal/vendor-reviews/${existing.id}` : "/api/portal/vendor-reviews";
      const res = await fetch(url, {
        method: existing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(existing ? { stars, body: notes } : { workOrderId: row.id, stars, body: notes }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        showToast?.(data.error || "Could not save the review.");
        return;
      }
      showToast?.(existing ? "Review updated." : "Review saved.");
      onSaved?.();
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <PortalDialog
      open={open}
      onClose={onClose}
      title={existing ? "Edit review" : "Leave a review"}
      dataAttr="vendor-review-dialog"
      primaryAction={
        readOnly
          ? null
          : {
              label: existing ? "Save review" : "Leave review",
              onClick: submit,
              disabled: loading || saving || stars < 1,
              loading: saving,
              dataAttr: "vendor-review-save",
            }
      }
    >
      <div className="space-y-4">
        {row.vendorName ? <p className="text-sm text-muted">{row.vendorName} · {row.title}</p> : null}
        {readOnly ? (
          <p className="text-sm text-muted">
            The 14-day edit window for this review has passed. It can no longer be changed.
          </p>
        ) : null}
        <div className="space-y-1.5">
          <span className="text-sm font-medium text-foreground">Rating</span>
          <VendorReviewStarPicker value={stars} onChange={setStars} disabled={readOnly || loading} dataAttr="vendor-review-star" />
        </div>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-foreground">Notes</span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value.slice(0, VENDOR_REVIEW_BODY_MAX_LENGTH))}
            rows={4}
            disabled={readOnly || loading}
            className="w-full rounded-2xl border border-border bg-card px-3.5 py-2 text-sm text-foreground outline-none transition focus:ring-2 focus:ring-primary/25 disabled:opacity-60"
            placeholder="How did it go?"
            data-attr="vendor-review-notes"
          />
        </label>
      </div>
    </PortalDialog>
  );
}
