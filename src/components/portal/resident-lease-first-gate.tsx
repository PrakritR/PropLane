"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { loadPublicPropertyLeadFromServer } from "@/lib/demo-property-pipeline";
import { residentLeaseDetailHref } from "@/lib/portal-detail-routes";
import { getPropertyById } from "@/lib/rental-application/data";

/**
 * A lease-first home has no application to start. Where the apply link would open the
 * application wizard, a lease-first home instead starts (or resumes) the resident's
 * lease — the marker draft whose Lease tab opens on the intake form, then the
 * lease-first signing wizard — and sends them there. An application-first home renders
 * `children` (the application wizard) untouched.
 */
export function ResidentLeaseFirstGate({
  propertyId,
  listingRoomId,
  basePath,
  children,
}: {
  propertyId: string;
  listingRoomId?: string;
  basePath: string;
  children: ReactNode;
}) {
  const portalNavigate = usePortalNavigate();
  const [state, setState] = useState<"checking" | "application" | "starting" | "failed">("checking");
  const startedFor = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await loadPublicPropertyLeadFromServer(propertyId);
      if (cancelled) return;
      if (getPropertyById(propertyId)?.signingOrder !== "lease_first") {
        setState("application");
        return;
      }
      if (startedFor.current === propertyId) return;
      startedFor.current = propertyId;
      setState("starting");
      try {
        const res = await fetch("/api/resident/lease-first-start", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ propertyId, roomChoice: listingRoomId }),
        });
        const data = (await res.json().catch(() => ({}))) as { leaseId?: string };
        if (cancelled) return;
        if (!res.ok || !data.leaseId) {
          setState("failed");
          return;
        }
        // REPLACE: Back should land where they came from, not on a page that redirects forward again.
        portalNavigate(residentLeaseDetailHref(basePath, "pending", data.leaseId), { replace: true });
      } catch {
        if (!cancelled) setState("failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [propertyId, listingRoomId, basePath, portalNavigate]);

  if (state === "application") return <>{children}</>;
  if (state === "failed") {
    return (
      <p className="text-sm text-muted" data-attr="resident-lease-first-start-failed">
        Could not start your lease. Reload to try again.
      </p>
    );
  }
  return (
    <p className="text-sm text-muted" data-attr="resident-lease-first-start">
      Opening your lease…
    </p>
  );
}
