"use client";

import {
  FilterCollapsibleSection,
  FilterFieldsAccordion,
  FilterSingleSelectList,
  filterSingleSelectSummary,
  useFilterAccordionClose,
} from "@/components/portal/filter-field-lists";
import { ApplicationFilterSortFields } from "@/components/portal/application-filter-sort-fields";
import {
  DEFAULT_PORTAL_LIST_GROUP_MODE,
  PORTAL_LIST_GROUP_MODE_LABELS,
  PORTAL_LIST_GROUP_MODES,
  type PortalListGroupMode,
} from "@/lib/portal-list-grouping";

/**
 * Group-by on its own, so a caller can put it FIRST and place the property
 * scope wherever it belongs. Every portal list leads with Group by, then Sort
 * by — bundling the two meant group-by could not lead without dragging the
 * property field up with it.
 */
export function PortalListGroupModeField({
  groupMode,
  onGroupModeChange,
  dataAttr = "portal-filter-group-mode",
  modeLabels = PORTAL_LIST_GROUP_MODE_LABELS,
  defaultMode = DEFAULT_PORTAL_LIST_GROUP_MODE,
}: {
  groupMode: PortalListGroupMode;
  onGroupModeChange: (next: PortalListGroupMode) => void;
  dataAttr?: string;
  modeLabels?: Record<PortalListGroupMode, string>;
  defaultMode?: PortalListGroupMode;
}) {
  const closeFieldMenu = useFilterAccordionClose();
  const groupModeOptions = PORTAL_LIST_GROUP_MODES.map((mode) => ({
    value: mode,
    label: modeLabels[mode],
  }));
  const summary = filterSingleSelectSummary(
    groupMode,
    groupModeOptions,
    modeLabels[defaultMode],
  );

  return (
    <FilterCollapsibleSection
      sectionId="group-mode"
      label="Group by"
      summary={summary}
      empty={groupMode === defaultMode}
      menuOptionCount={groupModeOptions.length}
      dataAttr={`${dataAttr}-trigger`}
    >
      <FilterSingleSelectList
        options={groupModeOptions}
        value={groupMode}
        onChange={(next) => onGroupModeChange(next as PortalListGroupMode)}
        onPick={closeFieldMenu}
        dataAttr={dataAttr}
      />
    </FilterCollapsibleSection>
  );
}

/** The property scope on its own, for callers that place it after their own fields. */
export function PortalListPropertyField({
  propertyOptions,
  propertyFilters,
  onPropertyFiltersChange,
  propertyAllLabel = "All houses",
  propertyDataAttr = "portal-filter-property",
}: {
  propertyOptions: { id: string; label: string }[];
  propertyFilters: string[];
  onPropertyFiltersChange: (next: string[]) => void;
  propertyAllLabel?: string;
  propertyDataAttr?: string;
}) {
  return (
    <ApplicationFilterSortFields
      propertyOptions={propertyOptions}
      propertyFilters={propertyFilters}
      onPropertyFiltersChange={onPropertyFiltersChange}
      allLabel={propertyAllLabel}
      dataAttr={propertyDataAttr}
      selectionMode="single"
    />
  );
}

/**
 * A person scope (the resident a service is for), shaped like the property
 * field: one dropdown, "All residents" first, pick closes the menu.
 */
export function PortalListResidentField({
  residentOptions,
  residentFilters,
  onResidentFiltersChange,
  allLabel = "All residents",
  dataAttr = "portal-filter-resident",
}: {
  residentOptions: { id: string; label: string }[];
  residentFilters: string[];
  onResidentFiltersChange: (next: string[]) => void;
  allLabel?: string;
  dataAttr?: string;
}) {
  const closeFieldMenu = useFilterAccordionClose();
  const options = [
    { value: "", label: allLabel },
    ...residentOptions.map((option) => ({ value: option.id, label: option.label })),
  ];
  const summary = filterSingleSelectSummary(residentFilters[0] ?? "", options, allLabel);

  return (
    <FilterCollapsibleSection
      sectionId="resident"
      label="Resident"
      summary={summary}
      empty={residentFilters.length === 0}
      menuOptionCount={options.length}
      dataAttr={`${dataAttr}-trigger`}
    >
      <FilterSingleSelectList
        options={options}
        value={residentFilters[0] ?? ""}
        onChange={(next) => onResidentFiltersChange(next ? [next] : [])}
        onPick={closeFieldMenu}
        dataAttr={dataAttr}
      />
    </FilterCollapsibleSection>
  );
}

/** Filter sheet fields shared by manager list tabs: property scope, optional resident scope, group-by. */
export function PortalListGroupFilterFields({
  groupMode,
  onGroupModeChange,
  propertyOptions,
  propertyFilters,
  onPropertyFiltersChange,
  propertyAllLabel = "All houses",
  propertyDataAttr = "portal-filter-property",
  groupModeDataAttr = "portal-filter-group-mode",
  showPropertyFilter = true,
  minPropertyOptions = 2,
  residentOptions,
  residentFilters,
  onResidentFiltersChange,
  residentDataAttr = "portal-filter-resident",
}: {
  groupMode: PortalListGroupMode;
  onGroupModeChange: (next: PortalListGroupMode) => void;
  propertyOptions?: { id: string; label: string }[];
  propertyFilters?: string[];
  onPropertyFiltersChange?: (next: string[]) => void;
  propertyAllLabel?: string;
  propertyDataAttr?: string;
  groupModeDataAttr?: string;
  showPropertyFilter?: boolean;
  /**
   * How many properties it takes before the Property field is drawn. Lists
   * that always want the scope visible (Services) pass 1 — a one-property
   * account should still see where the list is scoped.
   */
  minPropertyOptions?: number;
  residentOptions?: { id: string; label: string }[];
  residentFilters?: string[];
  onResidentFiltersChange?: (next: string[]) => void;
  residentDataAttr?: string;
}) {
  const hasPropertyFilter =
    showPropertyFilter &&
    propertyOptions &&
    propertyOptions.length >= minPropertyOptions &&
    propertyFilters &&
    onPropertyFiltersChange;
  const hasResidentFilter = residentOptions && residentFilters && onResidentFiltersChange;

  return (
    <FilterFieldsAccordion>
      {hasPropertyFilter ? (
        <ApplicationFilterSortFields
          propertyOptions={propertyOptions}
          propertyFilters={propertyFilters}
          onPropertyFiltersChange={onPropertyFiltersChange}
          allLabel={propertyAllLabel}
          dataAttr={propertyDataAttr}
          selectionMode="single"
        />
      ) : null}
      {hasResidentFilter ? (
        <PortalListResidentField
          residentOptions={residentOptions}
          residentFilters={residentFilters}
          onResidentFiltersChange={onResidentFiltersChange}
          dataAttr={residentDataAttr}
        />
      ) : null}
      <PortalListGroupModeField
        groupMode={groupMode}
        onGroupModeChange={onGroupModeChange}
        dataAttr={groupModeDataAttr}
      />
    </FilterFieldsAccordion>
  );
}
