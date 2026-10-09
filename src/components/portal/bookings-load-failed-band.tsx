"use client";

import { Button } from "@/components/ui/button";

/**
 * One compact band above Bookings when a source did not load (failed or timed
 * out). What did load is still drawn below it; Retry re-runs the sources.
 */
export function BookingsLoadFailedBand({ failedSources, onRetry }: { failedSources: readonly string[]; onRetry: () => void }) {
  if (failedSources.length === 0) return null;
  return (
    <div
      role="alert"
      data-testid="bookings-load-failed-band"
      className="flex shrink-0 items-center justify-between gap-3 rounded-xl border border-border bg-card/60 px-3 py-2 text-sm text-foreground"
    >
      <span>Some bookings didn&apos;t load.</span>
      <Button variant="secondary" data-attr="bookings-retry" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
