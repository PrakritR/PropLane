"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { GrowthResult } from "@/lib/growth/client";
import type { GrowthFormat, GrowthPlatform, GrowthPostStatus } from "@/lib/growth/types";

export const PLATFORM_LABEL: Record<GrowthPlatform, string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  youtube: "YouTube",
  linkedin: "LinkedIn",
  x: "X",
  threads: "Threads",
  facebook: "Facebook",
};

export const PLATFORM_SHORT: Record<GrowthPlatform, string> = {
  instagram: "IG",
  tiktok: "TikTok",
  youtube: "Shorts",
  linkedin: "LinkedIn",
  x: "X",
  threads: "Threads",
  facebook: "FB",
};

export const FORMAT_LABEL: Record<GrowthFormat, string> = {
  reel: "Reel",
  carousel: "Carousel",
  image: "Image",
  text: "Text",
};

export const FORMAT_CHIP: Record<GrowthFormat, string> = {
  reel: "border-primary/30 bg-primary/10 text-primary",
  carousel: "border-[var(--status-pending-fg)]/30 bg-[var(--status-pending-bg)] text-[var(--status-pending-fg)]",
  image: "border-[var(--status-confirmed-fg)]/30 bg-[var(--status-confirmed-bg)] text-[var(--status-confirmed-fg)]",
  text: "border-border bg-foreground/5 text-muted",
};

export const STATUS_LABEL: Record<GrowthPostStatus, string> = {
  idea: "Idea",
  drafted: "Drafted",
  review: "Needs your review",
  approved: "Approved",
  scheduled: "Scheduled",
  publishing: "Publishing",
  published: "Published",
  failed: "Failed",
  archived: "Archived",
};

const STATUS_TONE: Record<GrowthPostStatus, "neutral" | "success" | "warning" | "danger" | "info"> = {
  idea: "neutral",
  drafted: "neutral",
  review: "warning",
  approved: "info",
  scheduled: "info",
  publishing: "info",
  published: "success",
  failed: "danger",
  archived: "neutral",
};

export function GrowthStatusPill({ status }: { status: GrowthPostStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>;
}

export function GrowthChip({ children, on = false, className }: { children: ReactNode; on?: boolean; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold",
        on ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card text-muted",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function GrowthFormatChip({ format }: { format: GrowthFormat }) {
  return (
    <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold", FORMAT_CHIP[format])}>
      {FORMAT_LABEL[format]}
    </span>
  );
}

export function GrowthErrorBanner({ message, onRetry, dataAttr }: { message: string; onRetry?: () => void; dataAttr: string }) {
  return (
    <div
      role="alert"
      data-attr={dataAttr}
      className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-[var(--status-overdue-fg)]/30 bg-[var(--status-overdue-bg)] px-4 py-3 text-sm text-[var(--status-overdue-fg)]"
    >
      <span>{message}</span>
      {onRetry ? (
        <Button type="button" variant="outline" className="h-8 px-3 text-xs" data-attr={`${dataAttr}-retry`} onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

export function GrowthSkeletonBlocks({ count = 5, className }: { count?: number; className?: string }) {
  return (
    <div className={cn("animate-pulse motion-reduce:animate-none", className)} aria-busy="true" aria-label="Loading" data-attr="admin-growth-loading">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="mb-2 h-16 rounded-2xl bg-accent/55" />
      ))}
    </div>
  );
}

/** Load a GrowthResult-returning fetcher once on mount and on `reload()`. */
export function useGrowthLoad<T>(fetcher: () => Promise<GrowthResult<T>>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await fetcherRef.current();
      if (cancelled) return;
      if (result.ok) {
        setData(result.data);
        setError(null);
      } else {
        setData(null);
        setError(result.error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  const reload = useCallback(() => {
    setData(null);
    setError(null);
    setTick((n) => n + 1);
  }, []);
  return { data, error, loading: data === null && error === null, reload, setData };
}

/** Pacific wall-clock helpers for the schedule input (all admin growth times are Pacific). */
export const PACIFIC_TZ = "America/Los_Angeles";
