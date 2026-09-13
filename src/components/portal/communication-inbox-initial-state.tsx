"use client";

import { Button } from "@/components/ui/button";

/**
 * The first Communication list is assembled from more than one protected
 * source. Keep it noninteractive until all enabled sources have succeeded so
 * users never act on a partial list or a provisional empty state.
 */
export function CommunicationInboxInitialState({
  error,
  onRetry,
}: {
  error?: boolean;
  onRetry: () => Promise<void>;
}) {
  if (error) {
    return (
      <div className="p-4" role="alert">
        <p className="text-sm font-medium text-foreground">Could not load conversations.</p>
        <p className="mt-1 text-sm text-muted">Try again in a moment.</p>
        <Button type="button" variant="outline" className="mt-3" data-attr="communication-inbox-retry" onClick={onRetry}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="animate-pulse motion-reduce:animate-none" aria-busy="true" role="status">
      <span className="sr-only">Loading conversations…</span>
      {Array.from({ length: 4 }, (_, index) => (
        <div key={index} className="flex items-center gap-3 border-b border-border/50 px-3 py-3" aria-hidden="true">
          <div className="h-10 w-10 shrink-0 rounded-full bg-accent/55" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="h-3.5 w-2/5 max-w-40 rounded bg-accent/55" />
            <div className="h-3 w-3/5 max-w-56 rounded bg-accent/40" />
          </div>
          <div className="h-3 w-10 shrink-0 rounded bg-accent/45" />
        </div>
      ))}
    </div>
  );
}
