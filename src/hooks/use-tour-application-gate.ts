"use client";

import { useEffect, useState } from "react";
import type { MockProperty } from "@/data/types";
import type { TourBlockReason } from "@/lib/application-before-tour-policy";

export type TourApplicationGate =
  | { status: "open" }
  | { status: "checking" }
  | { status: "apply_first" }
  | { status: "pending_approval" }
  | { status: "denied" };

/**
 * "Application before a tour" (Settings -> Applications & leases). Only a property whose public
 * payload carries `applicationBeforeTour` is checked at all. For those, the server answers from
 * the caller's own session whether they already have a submitted application for the property
 * (`GET /api/public/tour-application-gate`); the booking route enforces the same rule regardless,
 * so a failed check can open the page but never a booking.
 */
export function useTourApplicationGate(
  property: Pick<MockProperty, "id" | "applicationBeforeTour">,
  options: { signedIn?: boolean } = {},
): TourApplicationGate {
  // A signed-in caller is always checked: a DENIED application blocks the tour whatever the setting.
  const needsCheck = property.applicationBeforeTour === true || options.signedIn === true;
  const [answer, setAnswer] = useState<{ propertyId: string; blocked: TourBlockReason | null } | null>(null);

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
          if (!cancelled) setAnswer({ propertyId: property.id, blocked: null });
          return;
        }
        const body = (await res.json()) as {
          required?: boolean;
          hasApplication?: boolean;
          allowed?: boolean;
          reason?: TourBlockReason | null;
        };
        if (cancelled) return;
        // `allowed`/`reason` are the server's one matrix; the older shape is read as "applied or not".
        const blocked: TourBlockReason | null =
          typeof body.allowed === "boolean"
            ? body.allowed
              ? null
              : (body.reason ?? "apply_first")
            : body.required !== true || body.hasApplication === true
              ? null
              : "apply_first";
        setAnswer({ propertyId: property.id, blocked });
      } catch {
        if (!cancelled) setAnswer({ propertyId: property.id, blocked: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [needsCheck, property.id]);

  if (!needsCheck) return { status: "open" };
  if (!answer || answer.propertyId !== property.id) return { status: "checking" };
  return answer.blocked ? { status: answer.blocked } : { status: "open" };
}
