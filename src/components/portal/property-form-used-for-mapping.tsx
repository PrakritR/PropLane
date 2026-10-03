"use client";

import { useMemo } from "react";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { WIZARD_LABEL_CLASS } from "@/components/portal/add-workspace/parts";
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
  pipelineOrder,
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
  const order = pipelineOrder === "lease_then_application" ? "lease_then_application" : "application_then_lease";
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

  const leaseFirst = order === "lease_then_application";

  if (stayTypes.length === 0) return null;

  return (
    <fieldset className="mt-4 space-y-3" data-attr="property-form-used-for-mapping">
      <legend className={WIZARD_LABEL_CLASS}>Used for</legend>
      <div className="space-y-2">
        {stayTypes.map((term) => {
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
            ...leaseOptions.map((opt) => ({ value: opt.value, label: opt.label })),
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
              dataAttr={`property-form-used-for-lease-${term.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`}
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
              dataAttr={`property-form-used-for-application-${term.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`}
              value={applicationValue}
              options={applicationSelectOptions}
              onChange={onApplicationPick}
            />
          );

          return (
            <div
              key={term}
              className="grid gap-2 rounded-xl border border-border bg-card px-3 py-2.5 sm:grid-cols-[minmax(0,7rem)_1fr_1fr]"
              data-attr={`property-form-used-for-row-${term.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`}
            >
              <span className="text-sm font-semibold text-foreground">{term}</span>
              {leaseFirst ? (
                <>
                  {leaseCol}
                  {applicationCol}
                </>
              ) : (
                <>
                  {applicationCol}
                  {leaseCol}
                </>
              )}
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}
