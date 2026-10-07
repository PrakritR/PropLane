"use client";

import type { ReactNode } from "react";
import { Home } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function OwnerPageTitle({ children }: { children: ReactNode }) {
  return <h1 className="mb-4 text-xl font-semibold tracking-tight text-foreground md:text-2xl">{children}</h1>;
}

export function OwnerTile({ label, value, of, tone }: { label: string; value: string; of?: string; tone?: "good" | "bad" }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4" data-attr="owner-tile">
      <p className="text-xs font-medium text-muted">{label}</p>
      <p
        className={cn(
          "mt-1 text-xl font-semibold tabular-nums md:text-2xl",
          tone === "good" && "text-emerald-600",
          tone === "bad" && "text-red-600",
        )}
      >
        {value}
        {of ? <span className="ml-1.5 text-[13px] font-medium text-muted">{of}</span> : null}
      </p>
    </div>
  );
}

export function OwnerTiles({ children }: { children: ReactNode }) {
  return <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">{children}</div>;
}

export function OwnerLoading() {
  return (
    <div role="status" aria-label="Loading" className="space-y-3">
      <span className="sr-only">Loading…</span>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-20 animate-pulse rounded-2xl bg-accent/50 motion-reduce:animate-none" />
        ))}
      </div>
      <div className="h-40 animate-pulse rounded-2xl bg-accent/50 motion-reduce:animate-none" />
      <div className="h-20 animate-pulse rounded-2xl bg-accent/50 motion-reduce:animate-none" />
      <div className="h-20 animate-pulse rounded-2xl bg-accent/50 motion-reduce:animate-none" />
    </div>
  );
}

export function OwnerError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex items-center justify-between gap-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
      <span>{message}</span>
      <Button variant="outline" onClick={onRetry} data-attr="owner-retry">
        Try again
      </Button>
    </div>
  );
}

export function OwnerEmpty({ title = "No activity yet" }: { title?: string }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-border bg-card px-6 py-12 text-center">
      <Home className="size-7 text-muted" aria-hidden />
      <p className="text-sm font-semibold text-foreground">{title}</p>
    </div>
  );
}

/** The band above a list: a count tab on the left, icon chrome on the right. */
export function OwnerBand({ children, label, count }: { children?: ReactNode; label: string; count?: number }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-2 border-b border-border/60 pb-1.5">
      <span className="text-sm font-semibold text-foreground">
        {label}
        {count !== undefined ? <span className="ml-1.5 rounded-full bg-accent px-1.5 py-0.5 text-[11px] text-muted">{count}</span> : null}
      </span>
      <div className="flex items-center gap-0.5">{children}</div>
    </div>
  );
}
