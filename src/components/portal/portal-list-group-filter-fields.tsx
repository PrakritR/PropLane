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
import { usePortalFilterDraft } from "@/lib/portal-filter-draft";

const GROUP_MODE_OPTIONS = PORTAL_LIST_GROUP_MODES.map((mode) => ({
  value: mode,
  label: PORTAL_LIST_GROUP_MODE_LABELS[mode],
}));

function GroupModeFilterFields({
  groupMode,
  onGroupModeChange,
  dataAttr = "portal-filter-group-mode",
}: {
  groupMode: PortalListGroupMode;
  onGroupModeChange: (next: PortalListGroupMode) => void;
  dataAttr?: string;
}) {
  const closeFieldMenu = useFilterAccordionClose();
  const [draftMode, setDraftMode] = usePortalFilterDraft(
    groupMode,
    onGroupModeChange,
    DEFAULT_PORTAL_LIST_GROUP_MODE,
  );
  const summary = filterSingleSelectSummary(
    draftMode,
    GROUP_MODE_OPTIONS,
    PORTAL_LIST_GROUP_MODE_LABELS[DEFAULT_PORTAL_LIST_GROUP_MODE],
  );

  return (
    <FilterCollapsibleSection
      sectionId="group-mode"
      label="Group by"
      summary={summary}
      empty={draftMode === DEFAULT_PORTAL_LIST_GROUP_MODE}
      menuOptionCount={GROUP_MODE_OPTIONS.length}
      dataAttr={`${dataAttr}-trigger`}
    >
      <FilterSingleSelectList
        options={GROUP_MODE_OPTIONS}
        value={draftMode}
        onChange={(next) => setDraftMode(next as PortalListGroupMode)}
        onPick={closeFieldMenu}
        dataAttr={dataAttr}
      />
    </FilterCollapsibleSection>
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
        <GroupModeFilterFields
          groupMode={groupMode}
          onGroupModeChange={onGroupModeChange}
          dataAttr={groupModeDataAttr}
        />
      </FilterFieldsAccordion>
    );
  }

  return (
    <FilterFieldsAccordion>
      <GroupModeFilterFields
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
