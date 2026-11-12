"use client";

import { useEffect, useState } from "react";
import { CircleAlert, Star } from "lucide-react";
import { RatingStars } from "@/components/portal/rating-stars";
import { RecordFactCard, RecordFactRow } from "@/components/portal/portal-record-overview-kit";
import { RATING_DISPUTE_LABEL, type ManagerRatingsView } from "@/lib/resident-ratings/ratings";

/**
 * What a manager sees about a person's past PropLane stays, on the person's application or resident record: the
 * average and count, then each review (stars, text, month and year, the house's city, and the person's response).
 * The server only answers for an application the person submitted to this workspace and for this workspace's own
 * residents, and never says who rated or which workspace; with nothing to show this draws nothing at all.
 */
export function ManagerResidentRatingsSection({ applicationId, refreshKey = 0 }: { applicationId: string; refreshKey?: number }) {
  const [view, setView] = useState<ManagerRatingsView | null>(null);

  useEffect(() => {
    if (!applicationId) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/manager-applications/${encodeURIComponent(applicationId)}/ratings`, { cache: "no-store" });
        if (!response.ok) {
          if (!cancelled) setView(null);
          return;
        }
        const body = (await response.json()) as ManagerRatingsView;
        if (!cancelled) setView(body);
      } catch {
        if (!cancelled) setView(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applicationId, refreshKey]);

  if (!view?.available) return null;

  return (
    <RecordFactCard title="Ratings" count={view.summary.count} dataAttr="resident-ratings-card">
      {view.summary.count === 0 || view.summary.average == null ? (
        <p className="px-[var(--portal-card-padding,14px)] py-5 text-center text-[13px] text-muted">No ratings yet.</p>
      ) : (
        <>
          <RecordFactRow
            label="Average"
            value={
              <span className="inline-flex items-center gap-1.5" data-attr="resident-ratings-average">
                <Star aria-hidden className="size-[14px] fill-current text-[var(--status-pending-fg)]" />
                <span className="font-medium">{view.summary.average.toFixed(1)}</span>
                <span className="text-muted">
                  {view.summary.count} {view.summary.count === 1 ? "rating" : "ratings"}
                </span>
              </span>
            }
          />
          <ul className="divide-y divide-border border-t border-border">
            {view.ratings.map((rating, index) => (
              <li key={`${rating.monthYear}-${index}`} className="space-y-1.5 px-[var(--portal-card-padding,14px)] py-3" data-attr="resident-rating-row">
                <div className="flex items-center gap-2 text-[13px]">
                  <RatingStars stars={rating.stars} />
                  <span className="text-muted">{[rating.monthYear, rating.city].filter(Boolean).join(" · ")}</span>
                </div>
                {rating.review ? <p className="whitespace-pre-wrap text-[13.5px] text-foreground">{rating.review}</p> : null}
                {rating.disputed ? (
                  <p className="flex items-center gap-1.5 text-[13px] text-[var(--status-pending-fg)]">
                    <CircleAlert aria-hidden className="size-[14px]" />
                    {RATING_DISPUTE_LABEL}
                  </p>
                ) : null}
                {rating.response ? (
                  <p className="whitespace-pre-wrap text-[13.5px] text-foreground">
                    <span className="text-muted">Resident response: </span>
                    {rating.response}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      )}
    </RecordFactCard>
  );
}
