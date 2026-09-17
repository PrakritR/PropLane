"use client";

import type { ReactNode } from "react";
import { PORTAL_DASHBOARD_STACK } from "@/components/portal/portal-metrics";

/**
 * Shared manager/vendor home chrome: optional banner, four KPI cards, the
 * Needs attention + Upcoming split, then the card grid. Both portals pass
 * their own numbers; the tree stays one shape.
 */
export function PortalHomeLayout({
  banner,
  kpis,
  split,
  below,
}: {
  banner?: ReactNode;
  kpis: ReactNode;
  split: ReactNode;
  below?: ReactNode;
}) {
  return (
    <div className={PORTAL_DASHBOARD_STACK}>
      {banner}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{kpis}</div>
      <div className="grid gap-3 lg:grid-cols-2">{split}</div>
      {below}
    </div>
  );
}
