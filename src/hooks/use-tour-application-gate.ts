"use client";

import { useEffect, useState } from "react";
import type { MockProperty } from "@/data/types";

export type TourApplicationGate =
  | { status: "open" }
  | { status: "checking" }
  | { status: "apply_first" };

/**
 * "Application before a tour" (Settings -> Applications & leases). Only a property whose public
 * payload carries `applicationBeforeTour` is checked at all. For those, the server answers from
 * the caller's own session whether they already have a submitted application for the property
 * (`GET /api/public/tour-application-gate`); the booking route enforces the same rule regardless,
 * so a failed check can open the page but never a booking.
 */
export function useTourApplicationGate(property: Pick<MockProperty, "id" | "applicationBeforeTour">): TourApplicationGate {
  const needsCheck = property.applicationBeforeTour === true;
  const [answer, setAnswer] = useState<{ propertyId: string; hasApplication: boolean } | null>(null);

  useEffect(() => {
    if (!needsCheck) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/public/tour-application-gate?propertyId=${encodeURIComponent(property.id)}`, {
          credentials: "include",
          cache: "no-store",
        });
        if (!res.ok) {
          // The check itself failed: open the flow rather than strand the visitor; the booking route still refuses.
          if (!cancelled) setAnswer({ propertyId: property.id, hasApplication: true });
          return;
        }
        const body = (await res.json()) as { required?: boolean; hasApplication?: boolean };
        if (cancelled) return;
        setAnswer({ propertyId: property.id, hasApplication: body.required !== true || body.hasApplication === true });
      } catch {
        if (!cancelled) setAnswer({ propertyId: property.id, hasApplication: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [needsCheck, property.id]);

  if (!needsCheck) return { status: "open" };
  if (!answer || answer.propertyId !== property.id) return { status: "checking" };
  return answer.hasApplication ? { status: "open" } : { status: "apply_first" };
}
