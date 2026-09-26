"use client";

import type { DemoPortalRole } from "@/lib/demo/demo-session";

/**
 * A scaled, non-interactive slice of the REAL `/demo` portal — used wherever
 * the public site used to hand-draw a replica of a portal screen (captain
 * 2026-09-25: "NOTHING like the real portal"). `/demo?role=&section=`
 * deep-links straight into one view (`demo-manager-shell.tsx`/`page.tsx`);
 * the iframe is a genuinely separate browsing context sized to the card, so
 * the app's own responsive layout renders at that width — no fixed "phone"
 * viewport + CSS scale needed here, unlike the hero window's phone mockup.
 * `pointer-events-none` plus `tabIndex={-1}` keep it a picture, not a second
 * interactive copy of the portal sitting mid-page.
 */
export function DemoRouteSlice({
  role,
  section,
  height,
  label,
}: {
  role: DemoPortalRole;
  section: string;
  height: number;
  label: string;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-[var(--shadow-sm)]" style={{ height }}>
      <iframe
        src={`/demo?role=${role}&section=${section}`}
        title={`PropLane ${label} — real portal preview`}
        loading="lazy"
        tabIndex={-1}
        aria-hidden="true"
        style={{ width: "100%", height: "100%", border: 0, pointerEvents: "none" }}
        className="block bg-white"
      />
    </div>
  );
}
