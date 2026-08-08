"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Full-height calendar tab body — one section per routed view (Tours / Bookings / Services). */
export function CalendarSectionShell({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn("flex min-h-0 flex-1 flex-col gap-3", className)}
      aria-label={title}
      data-calendar-section={title.toLowerCase().replace(/\s+/g, "-")}
    >
      <div className="flex shrink-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-foreground">{title}</h2>
          {description ? <p className="mt-0.5 text-sm text-muted">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
    </section>
  );
}
