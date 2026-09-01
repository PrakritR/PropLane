"use client";

import { useMemo } from "react";
import { PortalFilterSortSheet, portalFilterActiveCount } from "@/components/portal/portal-filter-sort-sheet";
import { PortalActiveFilterChips } from "@/components/portal/portal-filter-chips";
import { PortalListGroupFilterFields } from "@/components/portal/portal-list-group-filter-fields";
import {
  portalListGroupModeActiveCount,
  type PortalListGroupMode,
} from "@/lib/portal-list-grouping";
import { RESIDENT_PORTAL_DEFAULT_GROUP_MODE } from "@/components/portal/resident-portal-grouped-data-list";

export function useResidentPortalListFilterState({
  groupMode,
  onGroupModeChange,
  propertyOptions = [],
  propertyFilters = [],
  onPropertyFiltersChange,
  groupModeDataAttr = "resident-portal-filter-group-mode",
  propertyDataAttr = "resident-portal-filter-property",
}: {
  groupMode: PortalListGroupMode;
  onGroupModeChange: (next: PortalListGroupMode) => void;
  propertyOptions?: { id: string; label: string }[];
  propertyFilters?: string[];
  onPropertyFiltersChange?: (next: string[]) => void;
  groupModeDataAttr?: string;
  propertyDataAttr?: string;
}) {
  const filterFields = (
    <PortalListGroupFilterFields
      groupMode={groupMode}
      onGroupModeChange={onGroupModeChange}
      propertyOptions={propertyOptions}
      propertyFilters={propertyFilters}
      onPropertyFiltersChange={onPropertyFiltersChange}
      propertyAllLabel="All properties"
      groupModeDataAttr={groupModeDataAttr}
      propertyDataAttr={propertyDataAttr}
      showPropertyFilter={propertyOptions.length > 1}
    />
  );

  const filterSheet = (
    <PortalFilterSortSheet
      activeCount={portalFilterActiveCount([
        portalListGroupModeActiveCount(groupMode, RESIDENT_PORTAL_DEFAULT_GROUP_MODE),
        propertyFilters,
      ])}
      dataAttr="resident-portal-filter-open"
    >
      {filterFields}
    </PortalFilterSortSheet>
  );

  const activeFilterChips = useMemo(() => {
    const chips = [];
    if (groupMode !== RESIDENT_PORTAL_DEFAULT_GROUP_MODE) {
      chips.push({
        id: "group-mode",
        label: groupMode === "house" ? "Grouped by property" : "Flat list",
        onRemove: () => onGroupModeChange(RESIDENT_PORTAL_DEFAULT_GROUP_MODE),
      });
    }
    if (propertyFilters.length > 0) {
      const label =
        propertyOptions.find((option) => option.id === propertyFilters[0])?.label ?? "Property";
      chips.push({
        id: "property",
        label,
        onRemove: () => onPropertyFiltersChange?.([]),
      });
    }
    return chips.length > 0 ? <PortalActiveFilterChips chips={chips} /> : null;
  }, [groupMode, onGroupModeChange, onPropertyFiltersChange, propertyFilters, propertyOptions]);

  return { filterSheet, activeFilterChips };
}
