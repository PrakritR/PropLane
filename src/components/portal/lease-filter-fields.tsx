"use client";

import {
  FilterCheckboxList,
  FilterCollapsibleSection,
  FilterFieldsAccordion,
  FilterSingleSelectList,
  filterMultiSelectSummary,
  filterSingleSelectSummary,
} from "@/components/portal/filter-field-lists";
import { usePortalFilterDraft } from "@/lib/portal-filter-draft";

/** How recently a lease row was touched; `any` is the unfiltered default. */
export type LeaseUpdatedWindow = "any" | "7d" | "30d" | "90d";

export const LEASE_UPDATED_WINDOW_OPTIONS: { value: LeaseUpdatedWindow; label: string }[] = [
  { value: "any", label: "Any time" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
];

const WINDOW_DAYS: Record<Exclude<LeaseUpdatedWindow, "any">, number> = { "7d": 7, "30d": 30, "90d": 90 };

/** True when a lease last updated at `updatedAtIso` falls inside the window ending at `now`. An unparseable date never hides a lease. */
export function leaseUpdatedWithinWindow(updatedAtIso: string, window: LeaseUpdatedWindow, now = Date.now()): boolean {
  if (window === "any") return true;
  const at = Date.parse(updatedAtIso);
  if (Number.isNaN(at)) return true;
  return now - at <= WINDOW_DAYS[window] * 86_400_000;
}

export function leaseUpdatedWindowLabel(window: LeaseUpdatedWindow): string {
  return LEASE_UPDATED_WINDOW_OPTIONS.find((option) => option.value === window)?.label ?? "Any time";
}

/** The Leases Filter popover: Property · Stage · Updated. All three are columns the lease pipeline rows already carry. */
export function LeaseFilterFields({
  propertyOptions,
  propertyFilters,
  onPropertyFiltersChange,
  stageOptions,
  stageFilters,
  onStageFiltersChange,
  updatedWindow,
  onUpdatedWindowChange,
}: {
  propertyOptions: { id: string; label: string }[];
  propertyFilters: string[];
  onPropertyFiltersChange: (next: string[]) => void;
  stageOptions: { value: string; label: string }[];
  stageFilters: string[];
  onStageFiltersChange: (next: string[]) => void;
  updatedWindow: LeaseUpdatedWindow;
  onUpdatedWindowChange: (next: LeaseUpdatedWindow) => void;
}) {
  const [draftProperties, setDraftProperties] = usePortalFilterDraft(propertyFilters, onPropertyFiltersChange, []);
  const [draftStages, setDraftStages] = usePortalFilterDraft(stageFilters, onStageFiltersChange, []);
  const [draftWindow, setDraftWindow] = usePortalFilterDraft<LeaseUpdatedWindow>(
    updatedWindow,
    onUpdatedWindowChange,
    "any",
  );
  const propertyList = propertyOptions.map((option) => ({ value: option.id, label: option.label }));

  return (
    <FilterFieldsAccordion>
      <FilterCollapsibleSection
        sectionId="property"
        label="Property"
        summary={filterMultiSelectSummary(draftProperties, propertyList, "All properties")}
        empty={draftProperties.length === 0}
        menuOptionCount={propertyList.length}
        dataAttr="leases-filter-property-trigger"
      >
        <FilterCheckboxList
          options={propertyList}
          selected={draftProperties}
          onChange={setDraftProperties}
          emptyMenuText="No properties"
          dataAttr="leases-filter-property"
        />
      </FilterCollapsibleSection>
      <FilterCollapsibleSection
        sectionId="stage"
        label="Stage"
        summary={filterMultiSelectSummary(draftStages, stageOptions, "All stages")}
        empty={draftStages.length === 0}
        menuOptionCount={stageOptions.length}
        dataAttr="leases-filter-stage-trigger"
      >
        <FilterCheckboxList
          options={stageOptions}
          selected={draftStages}
          onChange={setDraftStages}
          emptyMenuText="No stages"
          dataAttr="leases-filter-stage"
        />
      </FilterCollapsibleSection>
      <FilterCollapsibleSection
        sectionId="updated"
        label="Updated"
        summary={filterSingleSelectSummary(draftWindow, LEASE_UPDATED_WINDOW_OPTIONS, "Any time")}
        empty={draftWindow === "any"}
        menuOptionCount={LEASE_UPDATED_WINDOW_OPTIONS.length}
        dataAttr="leases-filter-updated-trigger"
      >
        <FilterSingleSelectList
          options={LEASE_UPDATED_WINDOW_OPTIONS}
          value={draftWindow}
          onChange={(value) => setDraftWindow(value as LeaseUpdatedWindow)}
          dataAttr="leases-filter-updated"
        />
      </FilterCollapsibleSection>
    </FilterFieldsAccordion>
  );
}
