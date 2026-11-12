"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { RatingStarInput } from "@/components/portal/rating-stars";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { RATING_REVIEW_MAX, type ManagerRatingsView } from "@/lib/resident-ratings/ratings";

/**
 * The manager's Rate sheet on a resident record: 1-5 stars (required) and an optional written review. The server
 * decides everything else (whether this workspace housed them, whether the viewer may edit Residents, which stay);
 * the sheet sends `{ stars, review }` and the application id in the path, nothing more.
 */
export function ResidentRatingSheet({
  open,
  onClose,
  applicationId,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  applicationId: string;
  onSaved?: (view: ManagerRatingsView) => void;
}) {
  const { showToast } = useAppUi();
  const [loading, setLoading] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [stars, setStars] = useState(0);
  const [review, setReview] = useState("");
  const [error, setError] = useState<string | null>(null);
  const url = `/api/manager-applications/${encodeURIComponent(applicationId)}/ratings`;

  useEffect(() => {
    if (!open || !applicationId) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setLoading(true);
      setError(null);
      setRefusal(null);
    });
    void (async () => {
      try {
        const response = await fetch(url, { cache: "no-store" });
        const body = (await response.json()) as Partial<ManagerRatingsView> & { error?: string };
        if (cancelled) return;
        if (!response.ok) {
          setError(body.error ?? "Could not load this rating.");
          return;
        }
        setStars(body.own?.stars ?? 0);
        setReview(body.own?.review ?? "");
        setRefusal(body.canRate ? null : (body.rateRefusal ?? "You cannot rate this resident."));
      } catch {
        if (!cancelled) setError("Could not load this rating.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, applicationId, url]);

  const save = useCallback(async () => {
    if (stars < 1) {
      setError("Choose 1 to 5 stars.");
      return;
    }
    setError(null);
    try {
      const response = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stars, review }),
      });
      const body = (await response.json()) as ManagerRatingsView & { error?: string };
      if (!response.ok) {
        setError(body.error ?? "Could not save the rating.");
        return;
      }
      showToast("Rating saved.");
      onSaved?.(body);
      onClose();
    } catch {
      setError("Could not save the rating.");
    }
  }, [onClose, onSaved, review, showToast, stars, url]);

  const canSave = !loading && !refusal;

  return (
    <Modal
      open={open}
      title="Rate resident"
      onClose={onClose}
      panelClassName="max-w-md"
      contextPanel={null}
      preview={null}
      assistantStrip={false}
      dataAttr="resident-rating-sheet"
      footer={
        canSave ? (
          <ModalFooter>
            <Button type="button" disabled={stars < 1} onClick={() => save()} data-attr="resident-rating-save">
              Save
            </Button>
          </ModalFooter>
        ) : undefined
      }
    >
      <div className="space-y-4">
        {loading ? (
          <div role="status" aria-label="Loading" className="h-24 w-full animate-pulse rounded-xl bg-accent/40" />
        ) : refusal ? (
          <p role="alert" className="text-sm text-foreground">
            {refusal}
          </p>
        ) : (
          <>
            <RatingStarInput value={stars} onChange={setStars} dataAttr="resident-rating-stars" />
            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-foreground">Review</span>
              <textarea
                value={review}
                onChange={(event) => setReview(event.target.value.slice(0, RATING_REVIEW_MAX))}
                maxLength={RATING_REVIEW_MAX}
                rows={5}
                className="w-full rounded-2xl border border-border bg-card px-3.5 py-2 text-sm text-foreground outline-none transition focus:ring-2 focus:ring-primary/25"
                data-attr="resident-rating-review"
              />
            </label>
          </>
        )}
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
