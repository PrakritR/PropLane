"use client";

import Link from "next/link";
import { useProspectContactAutofill } from "@/hooks/use-prospect-contact-autofill";
import { buildProspectApplyHref } from "@/lib/prospect-public-nav";

/**
 * Shown in place of the tour flow when the property's workspace asks for an application first and
 * this visitor has none. The Apply door is the same one every listing CTA uses.
 */
export function TourApplicationFirstPanel({ propertyId, propertyTitle }: { propertyId: string; propertyTitle?: string }) {
  const autofill = useProspectContactAutofill();
  const applyHref = buildProspectApplyHref(
    { propertyId },
    { ready: autofill.ready, userId: autofill.userId, hasResidentRole: autofill.hasResidentRole },
  );
  return (
    <div className="space-y-4 py-2" data-attr="tour-application-first">
      <p className="text-base font-semibold text-foreground">Apply before you tour{propertyTitle ? ` ${propertyTitle}` : ""}</p>
      <p className="text-sm text-muted">This home asks for an application before a tour. Apply first, then book your tour.</p>
      <Link
        href={applyHref}
        data-attr="tour-application-first-apply"
        className="inline-flex rounded-full bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
      >
        Apply
      </Link>
    </div>
  );
}
