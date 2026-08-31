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
const GROUP_MODE_OPTIONS = PORTAL_LIST_GROUP_MODES.map((mode) => ({
  value: mode,
  label: PORTAL_LIST_GROUP_MODE_LABELS[mode],
}));

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
}: {
  groupMode: PortalListGroupMode;
  onGroupModeChange: (next: PortalListGroupMode) => void;
  dataAttr?: string;
}) {
  const closeFieldMenu = useFilterAccordionClose();
  const summary = filterSingleSelectSummary(
    groupMode,
    GROUP_MODE_OPTIONS,
    PORTAL_LIST_GROUP_MODE_LABELS[DEFAULT_PORTAL_LIST_GROUP_MODE],
  );

  return (
    <FilterCollapsibleSection
      sectionId="group-mode"
      label="Group by"
      summary={summary}
      empty={groupMode === DEFAULT_PORTAL_LIST_GROUP_MODE}
      menuOptionCount={GROUP_MODE_OPTIONS.length}
      dataAttr={`${dataAttr}-trigger`}
    >
      <FilterSingleSelectList
        options={GROUP_MODE_OPTIONS}
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

/** Filter sheet fields shared by manager list tabs: group-by plus optional property scope. */
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
}) {
  const hasPropertyFilter =
    showPropertyFilter &&
    propertyOptions &&
    propertyOptions.length > 1 &&
    propertyFilters &&
    onPropertyFiltersChange;

  if (!hasPropertyFilter) {
    return (
      <FilterFieldsAccordion>
        <PortalListGroupModeField
          groupMode={groupMode}
          onGroupModeChange={onGroupModeChange}
          dataAttr={groupModeDataAttr}
        />
      </FilterFieldsAccordion>
    );
  }

  return (
    <FilterFieldsAccordion>
      <PortalListGroupModeField
        groupMode={groupMode}
        onGroupModeChange={onGroupModeChange}
        dataAttr={groupModeDataAttr}
      />
      <ApplicationFilterSortFields
        propertyOptions={propertyOptions}
        propertyFilters={propertyFilters}
        onPropertyFiltersChange={onPropertyFiltersChange}
        allLabel={propertyAllLabel}
        dataAttr={propertyDataAttr}
        selectionMode="single"
      />
    </FilterFieldsAccordion>
  );
}
