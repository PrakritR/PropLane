"use client";

import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export type PricingView = "software" | "service";

/**
 * Software | Managed service, as a pair of tabs over two server-rendered panels.
 * Both panels are in the HTML (so a crawler reads both); only one is shown.
 * Used where the visitor should not leave the page, such as the home page band.
 */
export function PricingSwitch({
  software,
  service,
  defaultView = "software",
  attrPrefix = "pricing-switch",
}: {
  software: ReactNode;
  service: ReactNode;
  defaultView?: PricingView;
  attrPrefix?: string;
}) {
  const [view, setView] = useState<PricingView>(defaultView);
  const tab = (id: PricingView, label: string) => (
    <button
      type="button"
      role="tab"
      id={`${attrPrefix}-tab-${id}`}
      aria-selected={view === id}
      aria-controls={`${attrPrefix}-panel-${id}`}
      data-attr={`${attrPrefix}-${id}`}
      onClick={() => setView(id)}
      className={cn(
        "inline-flex min-h-[40px] items-center rounded-full px-5 text-[13.5px] font-bold transition-colors",
        view === id ? "bg-card text-foreground shadow-[var(--shadow-sm)]" : "text-muted hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
  return (
    <div>
      <div className="mb-8 flex justify-center">
        <div
          role="tablist"
          aria-label="Pricing"
          className="inline-flex items-center gap-1 rounded-full border border-border bg-[var(--pl-surface-muted)] p-1 [html[data-theme=dark]_&]:bg-white/[0.04]"
        >
          {tab("software", "Software")}
          {tab("service", "Managed service")}
        </div>
      </div>
      <div role="tabpanel" id={`${attrPrefix}-panel-software`} aria-labelledby={`${attrPrefix}-tab-software`} hidden={view !== "software"}>
        {software}
      </div>
      <div role="tabpanel" id={`${attrPrefix}-panel-service`} aria-labelledby={`${attrPrefix}-tab-service`} hidden={view !== "service"}>
        {service}
      </div>
    </div>
  );
}
