"use client";

import type { ReactNode } from "react";
import type { ManagerPropertyFilterOption } from "@/lib/manager-portfolio-access";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { PortalFilterChipRow } from "@/components/portal/portal-filter-chips";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { PORTAL_PAGE_TITLE, PortalKpiTabStrip } from "@/components/portal/portal-metrics";

export type ShellAction = {
  label: string;
  variant?: "primary" | "outline";
  onClick?: () => void;
  disabled?: boolean;
};

/** Property / resident / application filter chips — visible options, no dropdowns (Appendix E1). */
export function PortalPropertyFilterPill({
  applications,
  residents,
  propertyOptions,
  propertyValue,
  onPropertyChange,
  propertyPlaceholder,
  residentOptions,
  residentValue,
  onResidentChange,
  applicationOptions,
  applicationValue,
  onApplicationChange,
}: {
  applications?: boolean;
  residents?: boolean;
  propertyOptions?: ManagerPropertyFilterOption[];
  propertyValue?: string;
  onPropertyChange?: (propertyId: string) => void;
  residentOptions?: ManagerPropertyFilterOption[];
  residentValue?: string;
  onResidentChange?: (residentId: string) => void;
  applicationOptions?: ManagerPropertyFilterOption[];
  applicationValue?: string;
  onApplicationChange?: (axisId: string) => void;
  propertyPlaceholder?: string;
}) {
  const hasPropertyPick = Boolean(propertyOptions && propertyOptions.length > 0 && onPropertyChange);
  const hasResidentPick = Boolean(residents && residentOptions && residentOptions.length > 0 && onResidentChange);
  const hasApplicationPick = Boolean(applications && applicationOptions && applicationOptions.length > 0 && onApplicationChange);
  if (!hasPropertyPick && !hasResidentPick && !hasApplicationPick) return null;
  return (
    <PortalPropertyFilter
      applications={applications}
      residents={residents}
      propertyOptions={propertyOptions}
      propertyValue={propertyValue}
      onPropertyChange={onPropertyChange}
      residentOptions={residentOptions}
      residentValue={residentValue}
      onResidentChange={onResidentChange}
      applicationOptions={applicationOptions}
      applicationValue={applicationValue}
      onApplicationChange={onApplicationChange}
      propertyPlaceholder={propertyPlaceholder}
    />
  );
}

/** Shared property filter row for portal headers. */
export function PortalPropertyFilter({
  applications,
  residents,
  propertyOptions,
  propertyValue = "",
  onPropertyChange,
  residentOptions,
  residentValue = "",
  onResidentChange,
  applicationOptions,
  applicationValue = "",
  onApplicationChange,
  propertyPlaceholder,
}: {
  applications?: boolean;
  residents?: boolean;
  propertyOptions?: ManagerPropertyFilterOption[];
  propertyValue?: string;
  onPropertyChange?: (propertyId: string) => void;
  residentOptions?: ManagerPropertyFilterOption[];
  residentValue?: string;
  onResidentChange?: (residentId: string) => void;
  applicationOptions?: ManagerPropertyFilterOption[];
  applicationValue?: string;
  onApplicationChange?: (axisId: string) => void;
  propertyPlaceholder?: string;
}) {
  const hasPropertyPick = Boolean(propertyOptions && propertyOptions.length > 0 && onPropertyChange);
  const hasResidentPick = Boolean(residents && residentOptions && residentOptions.length > 0 && onResidentChange);
  const hasApplicationPick = Boolean(applications && applicationOptions && applicationOptions.length > 0 && onApplicationChange);
  if (!hasPropertyPick && !hasResidentPick && !hasApplicationPick) return null;
  return (
    <div className="flex w-full max-w-full flex-col gap-3">
      {hasPropertyPick ? (
        <PortalFilterChipRow
          ariaLabel="Properties"
          value={propertyValue}
          onChange={(next) => onPropertyChange?.(next)}
          allLabel={propertyPlaceholder ?? "All properties"}
          options={(propertyOptions ?? []).map((o) => ({ id: o.id, label: o.label }))}
        />
      ) : null}
      {hasResidentPick ? (
        <PortalFilterChipRow
          ariaLabel="Residents"
          value={residentValue}
          onChange={(next) => onResidentChange?.(next)}
          allLabel="All residents"
          options={(residentOptions ?? []).map((o) => ({ id: o.id, label: o.label }))}
        />
      ) : null}
      {hasApplicationPick ? (
        <PortalFilterChipRow
          ariaLabel="Applications"
          value={applicationValue}
          onChange={(next) => onApplicationChange?.(next)}
          allLabel="All applications"
          options={(applicationOptions ?? []).map((o) => ({ id: o.id, label: o.label }))}
        />
      ) : null}
    </div>
  );
}

/**
 * Minimal portal workspace shell (admin-style): title row, optional filters,
 * pill actions, optional KPI strip, then body.
 */
/** @deprecated Prefer {@link PortalListSectionShell} from portal-list-section.tsx for new list sections. */
export function ManagerSectionShell({
  title,
  filters,
  actions,
  kpis,
  activeKpiIndex: activeKpiIndexProp = 0,
  bodyClassName = "mt-6",
  children,
}: {
  title: string;
  filters?: ReactNode;
  actions?: ShellAction[];
  kpis?: { value: string; label: string }[];
  activeKpiIndex?: number;
  /** Spacing between header and main content (default mt-6). */
  bodyClassName?: string;
  children: ReactNode;
}) {
  const { showToast } = useAppUi();
  const [activeKpi, setActiveKpi] = useState(activeKpiIndexProp);

  return (
    <div className="relative z-0 flex min-h-0 w-full max-w-full flex-1 flex-col max-lg:flex-none">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <h1 className={PORTAL_PAGE_TITLE}>{title}</h1>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end">
          {filters ? <div className="flex flex-wrap items-center gap-2">{filters}</div> : null}
          {actions?.length ? (
            <div className="flex flex-wrap items-center gap-2">
              {actions.map((a) => (
                <Button
                  key={a.label}
                  type="button"
                  variant={a.variant ?? "outline"}
                  disabled={a.disabled}
                  onClick={
                    a.onClick ??
                    (() => {
                      showToast(
                        /refresh/i.test(a.label) ? "Refreshed." : `${a.label}.`,
                      );
                    })
                  }
                >
                  {a.label}
                </Button>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      {kpis?.length ? (
        <PortalKpiTabStrip
          items={kpis}
          activeIndex={activeKpi}
          onSelect={setActiveKpi}
          textAlign="center"
        />
      ) : null}

      <div className={`min-h-0 flex-1 flex flex-col ${bodyClassName}`}>{children}</div>
    </div>
  );
}
