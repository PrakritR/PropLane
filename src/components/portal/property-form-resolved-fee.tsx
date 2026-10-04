"use client";

import Link from "next/link";
import { useMemo } from "react";
import { ArrowUpRight } from "lucide-react";
import { WIZARD_LABEL_CLASS } from "@/components/portal/add-workspace/parts";
import { PropertyFormWizardCard, PropertyFormWizardRow } from "@/components/portal/property-form-wizard-kit";
import { propertyDetailHref } from "@/lib/portal-detail-routes";
import type { MappingCatalog } from "@/lib/application-lease-mapping";
import {
  applicationIdForStayTerm,
  leaseTemplateIdForStayTerm,
  offeredStayTypeTerms,
} from "@/lib/property-form-stay-type-routing";
import type { PropertyApplicationTemplate } from "@/lib/property-application-templates";
import type { PropertyLeaseTemplate } from "@/lib/property-lease-templates";
import { resolvedFormFees, type FormFeeKind } from "@/lib/form-resolved-fee";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

/**
 * The fee this form charges, read-only, with a link to the property's Pricing where it is set.
 *
 * One row per stay type the form serves. There is deliberately no input: Pricing owns the fee through the one
 * placement resolver (`form-resolved-fee.ts`), so the amount shown here is the amount charged. The link opens
 * Pricing in a new tab so an unsaved form is never lost.
 */
export function PropertyFormResolvedFee({
  sub,
  kind,
  terms,
  propertyId,
  basePath = "/portal",
}: {
  sub: ManagerListingSubmissionV1;
  kind: FormFeeKind;
  /** The stay types this form is used for. */
  terms: readonly string[];
  propertyId?: string | null;
  basePath?: string;
}) {
  const rows = useMemo(() => resolvedFormFees(sub, kind, terms), [sub, kind, terms]);
  if (rows.length === 0) return null;
  const legend = kind === "lease" ? "Lease fee" : "Application fee";
  const pricingHref = propertyId?.trim() ? propertyDetailHref(basePath, "all", propertyId.trim(), "pricing") : null;
  return (
    <fieldset className="mt-4 space-y-2" data-attr={`property-form-resolved-fee-${kind}`}>
      <div className="flex items-center justify-between gap-2">
        <legend className={WIZARD_LABEL_CLASS}>{legend}</legend>
        {pricingHref ? (
          <Link
            href={pricingHref}
            target="_blank"
            rel="noopener"
            aria-label="Edit in Pricing"
            title="Edit in Pricing"
            data-attr={`property-form-resolved-fee-${kind}-pricing-link`}
            className="inline-flex size-11 items-center justify-center rounded-lg text-foreground/80 transition hover:bg-[var(--secondary)]/70 hover:text-foreground md:size-9"
          >
            <ArrowUpRight className="size-[18px]" strokeWidth={1.75} aria-hidden />
          </Link>
        ) : null}
      </div>
      <PropertyFormWizardCard>
        {rows.map((row) => (
          <PropertyFormWizardRow
            key={row.term}
            label={row.term}
            dataAttr={`property-form-resolved-fee-${kind}-row`}
          >
            <span className="text-sm font-semibold tabular-nums text-foreground">{row.display}</span>
          </PropertyFormWizardRow>
        ))}
      </PropertyFormWizardCard>
    </fieldset>
  );
}

/**
 * The fee card for one form being edited: which stay types route to it (the same mapping the Used-for card
 * edits), then each one's fee from Pricing. Mount it right after the Used-for card with the same catalogs.
 */
export function PropertyFormFeeForCurrentForm({
  sub,
  mode,
  currentId,
  leaseTemplates,
  applicationTemplates,
  propertyId,
}: {
  sub: ManagerListingSubmissionV1;
  mode: FormFeeKind;
  currentId: string | null | undefined;
  leaseTemplates: PropertyLeaseTemplate[];
  applicationTemplates: PropertyApplicationTemplate[];
  propertyId?: string | null;
}) {
  const terms = useMemo(() => {
    if (!currentId) return [];
    const offered = offeredStayTypeTerms(sub);
    const catalog: MappingCatalog = { applications: applicationTemplates, leases: leaseTemplates };
    return offered.filter((term) =>
      mode === "lease"
        ? leaseTemplateIdForStayTerm(leaseTemplates, term) === currentId
        : applicationIdForStayTerm(catalog, "application_then_lease", leaseTemplates, term) === currentId,
    );
  }, [sub, mode, currentId, leaseTemplates, applicationTemplates]);
  return <PropertyFormResolvedFee sub={sub} kind={mode} terms={terms} propertyId={propertyId} />;
}
