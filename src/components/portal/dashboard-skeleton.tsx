"use client";

import { Button } from "@/components/ui/button";
import { ListSkeleton } from "@/components/ui/list-skeleton";

/**
 * Shape-matched placeholder for the manager/resident/admin dashboards: a KPI
 * tile row + a "needs attention" list. Used while the dashboard's own session
 * or data has not resolved yet, so the page never blanks to nothing (AXI
 * night sweep — `pro-dashboard.tsx` and `resident-dashboard.tsx` used to
 * `return null` / render zero cards on a slow phone connection).
 */
export function DashboardSkeleton() {
  return (
    <div className="min-w-0 space-y-5" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading dashboard…</span>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-hidden>
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="h-24 animate-pulse rounded-2xl border border-border bg-accent/30 motion-reduce:animate-none" />
        ))}
      </div>
      <div className="space-y-3" aria-hidden>
        <div className="h-5 w-36 animate-pulse rounded-full bg-accent/50 motion-reduce:animate-none" />
        <ListSkeleton rows={3} showLeading={false} />
      </div>
    </div>
  );
}

/** Inline retry card for a dashboard whose data failed to resolve. */
export function DashboardLoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <div role="alert" className="rounded-2xl border border-border bg-card p-6 text-center">
      <p className="mb-3 text-sm text-muted">Couldn&apos;t load your dashboard.</p>
      <Button variant="outline" onClick={onRetry} data-attr="dashboard-load-error-retry">
        Try again
      </Button>
    </div>
  );
}
