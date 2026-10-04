"use client";

import Link from "next/link";
import { useProspectContactAutofill } from "@/hooks/use-prospect-contact-autofill";
import { buildProspectApplyHref } from "@/lib/prospect-public-nav";
import { TOUR_BLOCK_LABELS, TOUR_BLOCK_MESSAGES, type TourBlockReason } from "@/lib/application-before-tour-policy";

/**
 * Shown in place of the tour flow when the property's workspace asks for an application first and
 * this visitor has none. The Apply door is the same one every listing CTA uses.
 */
export function TourApplicationFirstPanel({
  propertyId,
  propertyTitle,
  reason = "apply_first",
}: {
  propertyId: string;
  propertyTitle?: string;
  reason?: TourBlockReason;
}) {
  const autofill = useProspectContactAutofill();
  const applyHref = buildProspectApplyHref(
    { propertyId },
    { ready: autofill.ready, userId: autofill.userId, hasResidentRole: autofill.hasResidentRole },
  );
  return (
    <div className="space-y-4 py-2" data-attr="tour-application-first">
      <p className="text-base font-semibold text-foreground">
        {reason === "apply_first" ? "Apply before you tour" : reason === "pending_approval" ? "Tour opens once approved" : "Tours are closed for this home"}
        {propertyTitle ? ` ${propertyTitle}` : ""}
      </p>
      <p className="text-sm text-muted">{TOUR_BLOCK_MESSAGES[reason]}</p>
      {reason === "apply_first" ? (
      <Link
        href={applyHref}
        data-attr="tour-application-first-apply"
        className="inline-flex rounded-full bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
      >
        Apply
      </Link>
      ) : null}
    </div>
  );
}

/**
 * Inline blocked state for a picker that cannot continue: one heading-style line for the gate's
 * reason, plus the Apply door only when an application is what is missing.
 */
export function TourBlockedNotice({ applyHref, reason }: { applyHref: string; reason: TourBlockReason }) {
  return (
    <div
      role="status"
      data-attr="tour-blocked-notice"
      data-reason={reason}
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3"
    >
      <p className="text-sm font-semibold text-foreground">{TOUR_BLOCK_LABELS[reason]}</p>
      {reason === "apply_first" ? (
        <Link
          href={applyHref}
          data-attr="tour-blocked-notice-apply"
          className="inline-flex rounded-full bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
        >
          Apply
        </Link>
      ) : null}
    </div>
  );
}
