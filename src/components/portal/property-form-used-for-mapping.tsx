"use client";

import { useMemo } from "react";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { WIZARD_LABEL_CLASS } from "@/components/portal/add-workspace/parts";
import {
  PropertyFormWizardCard,
  PropertyFormWizardRow,
} from "@/components/portal/property-form-wizard-kit";
import {
  applicationIdForStayTerm,
  assignStayTermToLeaseTemplate,
  leaseTemplateIdForStayTerm,
  offeredStayTypeTerms,
  applyApplicationLinkForStayTerm,
} from "@/lib/property-form-stay-type-routing";
import {
  mappableApplicationTemplates,
  mappableLeaseTemplates,
  type MappingCatalog,
} from "@/lib/application-lease-mapping";
import type { PipelineOrder } from "@/lib/leasing-pipeline-preferences";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import type { PropertyApplicationTemplate } from "@/lib/property-application-templates";
import type { PropertyLeaseTemplate } from "@/lib/property-lease-templates";
import {
  DEFAULT_APPLICATION_TERM,
  DEFAULT_LEASE_TERM,
} from "@/lib/rental-application/forms-terminology";

const THIS_DOCUMENT = "__this__";
const NONE = "__none__";

export function PropertyFormUsedForMapping({
  sub,
  pipelineOrder: _pipelineOrder,
  leaseLabel = DEFAULT_LEASE_TERM,
  applicationLabel = DEFAULT_APPLICATION_TERM,
  mode,
  currentLeaseId,
  currentApplicationId,
  leaseTemplates,
  applicationTemplates,
  onLeaseTemplatesChange,
  onApplicationTemplatesChange,
  onError,
}: {
  sub: ManagerListingSubmissionV1;
  pipelineOrder: PipelineOrder;
  leaseLabel?: string;
  applicationLabel?: string;
  mode: "lease" | "application";
  currentLeaseId?: string | null;
  currentApplicationId?: string | null;
  leaseTemplates: PropertyLeaseTemplate[];
  applicationTemplates: PropertyApplicationTemplate[];
  onLeaseTemplatesChange: (next: PropertyLeaseTemplate[]) => void;
  onApplicationTemplatesChange: (next: PropertyApplicationTemplate[]) => void;
  onError?: (message: string) => void;
}) {
  // Application first, always: the stored order is ignored (captain, Oct 3 2026).
  const order = "application_then_lease" as const;
  const stayTypes = useMemo(() => offeredStayTypeTerms(sub), [sub]);
  const catalog = useMemo(
    (): MappingCatalog => ({ applications: applicationTemplates, leases: leaseTemplates }),
    [applicationTemplates, leaseTemplates],
  );

  const leaseOptions = useMemo(
    () =>
      mappableLeaseTemplates(leaseTemplates).map((row) => ({
        value: row.id,
        label: row.label?.trim() || leaseLabel,
      })),
    [leaseTemplates, leaseLabel],
  );

  const applicationOptions = useMemo(
    () =>
      mappableApplicationTemplates(applicationTemplates).map((row) => ({
        value: row.id,
        label: row.label?.trim() || applicationLabel,
      })),
    [applicationTemplates, applicationLabel],
  );

  if (stayTypes.length === 0) return null;

  return (
    <fieldset className="mt-4 space-y-2" data-attr="property-form-used-for-mapping">
      <legend className={WIZARD_LABEL_CLASS}>Used for</legend>
      <PropertyFormWizardCard dataAttr="property-form-used-for-card">
        {stayTypes.map((term) => {
          const slug = term.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
          const mappedLeaseId = leaseTemplateIdForStayTerm(leaseTemplates, term);
          const mappedApplicationId = applicationIdForStayTerm(catalog, order, leaseTemplates, term);
          const leaseValue =
            mode === "lease"
              ? mappedLeaseId === currentLeaseId
                ? THIS_DOCUMENT
                : mappedLeaseId ?? NONE
              : mappedLeaseId ?? NONE;
          const applicationValue =
            mode === "application"
              ? mappedApplicationId === currentApplicationId
                ? THIS_DOCUMENT
                : mappedApplicationId ?? NONE
              : mappedApplicationId ?? NONE;

          const leaseSelectOptions = [
            { value: NONE, label: "No lease" },
            ...(mode === "lease" ? [{ value: THIS_DOCUMENT, label: "This lease" }] : []),
            ...leaseOptions
              .filter((opt) => mode !== "lease" || opt.value !== currentLeaseId)
              .map((opt) => ({ value: opt.value, label: opt.label })),
          ];

          const applicationSelectOptions = [
            { value: NONE, label: `No ${applicationLabel.toLowerCase()}` },
            ...(mode === "application"
              ? [{ value: THIS_DOCUMENT, label: `This ${applicationLabel.toLowerCase()}` }]
              : []),
            ...applicationOptions
              .filter((opt) => mode !== "application" || opt.value !== currentApplicationId)
              .map((opt) => ({ value: opt.value, label: opt.label })),
          ];

          const onLeasePick = (raw: string) => {
            const targetId =
              raw === THIS_DOCUMENT ? currentLeaseId ?? null : raw === NONE ? null : raw;
            onLeaseTemplatesChange(assignStayTermToLeaseTemplate(leaseTemplates, term, targetId));
          };

          const onApplicationPick = (raw: string) => {
            const target =
              raw === THIS_DOCUMENT
                ? currentApplicationId ?? null
                : raw === NONE
                  ? null
                  : raw;
            const result = applyApplicationLinkForStayTerm(
              order,
              catalog,
              leaseTemplates,
              term,
              target,
            );
            if ("error" in result) {
              onError?.(result.error);
              return;
            }
            onApplicationTemplatesChange(result.applications);
            onLeaseTemplatesChange(result.leases);
          };

          const leaseCol = (
            <FieldSingleSelect
              hideLabel
              label={`${leaseLabel} for ${term}`}
              labelClassName={WIZARD_LABEL_CLASS}
              variant="cell"
              className="min-w-0 flex-1"
              value={leaseValue}
              options={leaseSelectOptions}
              dataAttr={`property-form-used-for-lease-${slug}`}
              onChange={onLeasePick}
            />
          );

          const applicationCol = (
            <FieldSingleSelect
              hideLabel
              label={`${applicationLabel} for ${term}`}
              labelClassName={WIZARD_LABEL_CLASS}
              variant="cell"
              className="min-w-0 flex-1"
              dataAttr={`property-form-used-for-application-${slug}`}
              value={applicationValue}
              options={applicationSelectOptions}
              onChange={onApplicationPick}
            />
          );

          return (
            <PropertyFormWizardRow
              key={term}
              label={term}
              dataAttr={`property-form-used-for-row-${slug}`}
              className="flex-wrap sm:flex-nowrap"
            >
              {/* One system (captain, Oct 3): application first, then lease — always. */}
              <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:justify-end">
                {applicationCol}
                {leaseCol}
              </div>
            </PropertyFormWizardRow>
          );
        })}
      </PropertyFormWizardCard>
    </fieldset>
  );
}
