"use client";

import { useEffect, useMemo, useState } from "react";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { PopupReviewPreview, PopupSubjectCard } from "@/components/portal/popup-live-preview";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { VendorReviewStarPicker } from "@/components/portal/vendor-review-stars";
import { canEditVendorReview, VENDOR_REVIEW_BODY_MAX_LENGTH, type VendorReview } from "@/lib/vendor-reviews";
import { useAppUi } from "@/components/providers/app-ui-provider";

export type VendorReviewDialogRow = { id: string; title: string; vendorName?: string };

/** A service the reviewer may pick — finished, or at least estimated by the vendor. */
export type VendorReviewServiceOption = { id: string; title: string };

/**
 * Manager "Leave a review" / "Edit review" dialog for one service (completed, or at least
 * estimated by the vendor). With `services` and no fixed `row`, the dialog opens with a
 * Service dropdown and attaches the review to the one picked; the server re-derives
 * eligibility either way (`POST /api/portal/vendor-reviews`).
 * Loads the workspace's existing review for the work order (if any) so it
 * opens straight into edit mode within the 14-day window.
 */
export function VendorReviewDialog({
  open,
  row: fixedRow,
  services,
  vendorName,
  vendorUserId,
  onClose,
  onSaved,
}: {
  open: boolean;
  row?: VendorReviewDialogRow | null;
  /** Eligible services to choose from when no `row` is fixed. */
  services?: readonly VendorReviewServiceOption[];
  vendorName?: string;
  /** The vendor being reviewed; the server refuses a service that belongs to anyone else. */
  vendorUserId?: string | null;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const [pickedId, setPickedId] = useState("");
  const picking = !fixedRow && Boolean(services);
  const picked = picking ? services?.find((service) => service.id === pickedId) : undefined;
  const row = useMemo<VendorReviewDialogRow | null>(
    () => fixedRow ?? (picked ? { id: picked.id, title: picked.title, vendorName } : null),
    [fixedRow, picked, vendorName],
  );
  const { showToast } = useAppUi();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [existing, setExisting] = useState<VendorReview | null>(null);
  const [stars, setStars] = useState(0);
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (!open) setPickedId("");
  }, [open]);

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

  if (!row && !picking) return null;

  // C158: a posted review can never be edited, so an existing review always
  // renders read-only — `canEditVendorReview` is the single source of that
  // "never" decision (also enforced server-side by the PATCH route).
  const readOnly = Boolean(existing) && !canEditVendorReview(existing?.createdAt ?? "");

  const submit = async () => {
    if (!row || stars < 1 || readOnly) return;
    setSaving(true);
    try {
      const res = await fetch(existing ? `/api/portal/vendor-reviews/${encodeURIComponent(existing.id)}` : "/api/portal/vendor-reviews", {
        method: existing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workOrderId: row.id, ...(vendorUserId ? { vendorUserId } : {}), stars, body: notes }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        showToast?.(data.error || "Could not save the review.");
        return;
      }
      showToast?.("Review saved.");
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
      title={existing ? "Review" : "Leave a review"}
      dataAttr="vendor-review-dialog"
      contextPanel={<PopupSubjectCard title={row?.vendorName || vendorName || row?.title || "Service"} lines={[row ? row.title : null, existing ? "Already reviewed" : null]} />}
      previewLabel="Review preview"
      preview={<PopupReviewPreview stars={stars} body={notes} subject={row?.title ?? vendorName ?? ""} />}
      primaryAction={
        readOnly
          ? null
          : {
              label: existing ? "Save review" : "Leave review",
              onClick: submit,
              disabled: !row || loading || saving || stars < 1,
              loading: saving,
              dataAttr: "vendor-review-save",
            }
      }
    >
      <div className="space-y-4">
        {picking ? (
          <FieldSingleSelect
            label="Service"
            value={pickedId}
            onChange={setPickedId}
            placeholder="Choose a service"
            options={(services ?? []).map((service) => ({ value: service.id, label: service.title }))}
            dataAttr="vendor-review-service"
          />
        ) : null}
        {readOnly ? (
          <p className="text-sm text-muted">The fourteen-day editing window has ended.</p>
        ) : null}
        <div className="space-y-1.5">
          <span className="text-sm font-medium text-foreground">Rating</span>
          <VendorReviewStarPicker value={stars} onChange={setStars} disabled={readOnly || loading || !row} dataAttr="vendor-review-star" />
        </div>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-foreground">Notes</span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value.slice(0, VENDOR_REVIEW_BODY_MAX_LENGTH))}
            rows={4}
            disabled={readOnly || loading || !row}
            className="w-full rounded-2xl border border-border bg-card px-3.5 py-2 text-sm text-foreground outline-none transition focus:ring-2 focus:ring-primary/25 disabled:opacity-60"
            placeholder="How did it go?"
            data-attr="vendor-review-notes"
          />
        </label>
      </div>
    </PortalDialog>
  );
}
