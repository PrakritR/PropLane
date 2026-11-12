"use client";

import { useCallback, useEffect, useState } from "react";
import { CircleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { RatingStars } from "@/components/portal/rating-stars";
import { PortalSettingsGroup, PortalSettingsSection } from "@/components/portal/portal-settings-ui";
import { useAppUi } from "@/components/providers/app-ui-provider";
import {
  RATING_DISPUTE_LABEL,
  RATING_RESPONSE_MAX,
  RATING_REVIEW_MAX,
  type ResidentFacingRating,
} from "@/lib/resident-ratings/ratings";

type Pending = { kind: "respond" | "dispute"; rating: ResidentFacingRating } | null;

/**
 * The person's own ratings from managers who housed them, in their Profile: stars, the written review, month and
 * year, and the house's city (never who rated). They may add one public response per rating (it is shown beside the
 * review to future managers) and may Dispute one, which opens a PropLane support thread and marks the rating
 * "Disputed by resident" for future managers until PropLane resolves it. Draws nothing while there are none.
 */
export function ResidentRatingsSettings() {
  const { showToast } = useAppUi();
  const [ratings, setRatings] = useState<ResidentFacingRating[]>([]);
  const [pending, setPending] = useState<Pending>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/resident/ratings", { cache: "no-store" });
      if (!response.ok) return;
      const body = (await response.json()) as { ratings?: ResidentFacingRating[] };
      setRatings(Array.isArray(body.ratings) ? body.ratings : []);
    } catch {
      /* the section simply stays hidden */
    }
  }, []);
  useEffect(() => {
    queueMicrotask(() => void load());
  }, [load]);

  const open = (kind: "respond" | "dispute", rating: ResidentFacingRating) => {
    setPending({ kind, rating });
    setText(kind === "respond" ? (rating.response ?? "") : "");
    setError(null);
  };

  const submit = async () => {
    if (!pending) return;
    setError(null);
    const isResponse = pending.kind === "respond";
    try {
      const response = await fetch(
        `/api/resident/ratings/${encodeURIComponent(pending.rating.id)}/${isResponse ? "response" : "dispute"}`,
        {
          method: isResponse ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(isResponse ? { response: text } : { reason: text }),
        },
      );
      const body = (await response.json()) as { rating?: ResidentFacingRating; error?: string };
      if (!response.ok || !body.rating) {
        setError(body.error ?? "Could not save that.");
        return;
      }
      const next = body.rating;
      setRatings((current) => current.map((rating) => (rating.id === next.id ? next : rating)));
      showToast(isResponse ? "Response saved." : "Sent to PropLane support.");
      setPending(null);
    } catch {
      setError("Could not save that.");
    }
  };

  if (ratings.length === 0) return null;

  return (
    <>
      <PortalSettingsSection title="Ratings" id="ratings">
        <PortalSettingsGroup>
          <ul className="divide-y divide-border" data-attr="resident-ratings-list">
            {ratings.map((rating) => (
              <li key={rating.id} className="space-y-1.5 px-4 py-3" data-attr="resident-rating-item">
                <div className="flex items-center gap-2 text-sm">
                  <RatingStars stars={rating.stars} />
                  <span className="text-muted">{[rating.monthYear, rating.city].filter(Boolean).join(" · ")}</span>
                </div>
                {rating.review ? <p className="whitespace-pre-wrap text-[15px] text-foreground">{rating.review}</p> : null}
                {rating.response ? (
                  <p className="whitespace-pre-wrap text-[15px] text-foreground">
                    <span className="text-muted">Your response: </span>
                    {rating.response}
                  </p>
                ) : null}
                <div className="flex items-center gap-4 text-sm">
                  <button
                    type="button"
                    className="text-primary"
                    onClick={() => open("respond", rating)}
                    data-attr="resident-rating-respond"
                  >
                    {rating.response ? "Edit response" : "Respond"}
                  </button>
                  {rating.disputed ? (
                    <span className="inline-flex items-center gap-1.5 text-[var(--status-pending-fg)]">
                      <CircleAlert aria-hidden className="size-[14px]" />
                      {RATING_DISPUTE_LABEL}
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="text-primary"
                      onClick={() => open("dispute", rating)}
                      data-attr="resident-rating-dispute"
                    >
                      Dispute
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </PortalSettingsGroup>
      </PortalSettingsSection>
      <Modal
        open={pending !== null}
        title={pending?.kind === "dispute" ? "Dispute rating" : "Respond to rating"}
        onClose={() => setPending(null)}
        panelClassName="max-w-md"
        contextPanel={null}
        preview={null}
        assistantStrip={false}
        dataAttr="resident-rating-modal"
        footer={
          <ModalFooter>
            <Button type="button" onClick={() => submit()} data-attr="resident-rating-submit">
              {pending?.kind === "dispute" ? "Send to support" : "Save"}
            </Button>
          </ModalFooter>
        }
      >
        <div className="space-y-3">
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-foreground">{pending?.kind === "dispute" ? "What is wrong" : "Response"}</span>
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              maxLength={pending?.kind === "dispute" ? RATING_REVIEW_MAX : RATING_RESPONSE_MAX}
              rows={5}
              className="w-full rounded-2xl border border-border bg-card px-3.5 py-2 text-sm text-foreground outline-none transition focus:ring-2 focus:ring-primary/25"
              data-attr="resident-rating-text"
            />
          </label>
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
        </div>
      </Modal>
    </>
  );
}
