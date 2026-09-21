"use client";

import { CommunicationStatusFilter } from "@/components/portal/communication-status-filter";

import {
  FilterCheckboxList,
  FilterCollapsibleSection,
  FilterFieldsAccordion,
  FilterSingleSelectList,
  filterMultiSelectSummary,
  filterSingleSelectSummary,
} from "@/components/portal/filter-field-lists";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { usePortalFilterDraft } from "@/lib/portal-filter-draft";
import {
  RECORD_KIND_FILTER_OPTIONS,
  type CommunicationFilterRole,
  type CommunicationThreadFilters,
} from "@/lib/communication-thread-filters";
import type { RecordKind } from "@/lib/portals/record-kinds";
import type { CommunicationListSort } from "@/lib/unified-inbox-merge";

const SORT_OPTIONS: { value: CommunicationListSort; label: string }[] = [
  { value: "recent", label: "Most recent" },
  { value: "resident", label: "Resident (A–Z)" },
];

export function CommunicationFilterSortFields({
  propertyOptions,
  roleOptions,
  filters,
  onFiltersChange,
  listSort,
  onListSortChange,
  hideArchived = false,
}: {
  propertyOptions: { value: string; label: string }[];
  roleOptions: { value: CommunicationFilterRole; label: string }[];
  filters: CommunicationThreadFilters;
  onFiltersChange: (next: CommunicationThreadFilters) => void;
  listSort: CommunicationListSort;
  onListSortChange: (next: CommunicationListSort) => void;
  hideArchived?: boolean;
}) {
  const [draftFilters, setDraftFilters] = usePortalFilterDraft(
    filters,
    onFiltersChange,
    { propertyIds: [], roles: [], contactIds: [] },
  );
  const [draftListSort, setDraftListSort] = usePortalFilterDraft(listSort, onListSortChange, "recent");

  const propertyListOptions = propertyOptions.map((option) => ({ value: option.value, label: option.label }));
  const roleListOptions = roleOptions.map((option) => ({ value: option.value, label: option.label }));

  return (
    <FilterFieldsAccordion>
      <CommunicationStatusFilter
        value={draftFilters.status ?? "active"}
        onChange={(status) => setDraftFilters({ ...draftFilters, status })}
        hideArchived={hideArchived}
      />
      <FilterCollapsibleSection
        sectionId="house"
        label="House"
        summary={filterMultiSelectSummary(draftFilters.propertyIds, propertyListOptions, "All houses")}
        empty={draftFilters.propertyIds.length === 0}
        menuOptionCount={propertyListOptions.length}
        dataAttr="communication-filter-house-trigger"
      >
        <FilterCheckboxList
          options={propertyListOptions}
          selected={draftFilters.propertyIds}
          onChange={(propertyIds) => setDraftFilters({ ...draftFilters, propertyIds })}
          emptyMenuText="No houses"
          dataAttr="communication-filter-house"
        />
      </FilterCollapsibleSection>

      <FilterCollapsibleSection
        sectionId="role"
        label="Role"
        summary={filterMultiSelectSummary(draftFilters.roles, roleListOptions, "All roles")}
        empty={draftFilters.roles.length === 0}
        menuOptionCount={roleListOptions.length}
        dataAttr="communication-filter-role-trigger"
      >
        <FilterCheckboxList
          options={roleListOptions}
          selected={draftFilters.roles}
          onChange={(roles) =>
            setDraftFilters({
              ...draftFilters,
              roles: roles as CommunicationFilterRole[],
              contactIds: [],
            })
          }
          emptyMenuText="No roles"
          dataAttr="communication-filter-role"
        />
      </FilterCollapsibleSection>

      <FieldSingleSelect
        label="About"
        value={draftFilters.recordKinds?.[0] ?? ""}
        onChange={(next) =>
          setDraftFilters({ ...draftFilters, recordKinds: next ? [next as RecordKind] : [] })
        }
        options={[{ value: "", label: "All records" }, ...RECORD_KIND_FILTER_OPTIONS]}
        placeholder="All records"
        dataAttr="communication-filter-about"
      />

      <FilterCollapsibleSection
        sectionId="sort"
        label="Sort"
        summary={filterSingleSelectSummary(draftListSort, SORT_OPTIONS, "Most recent")}
        empty={draftListSort === "recent"}
        menuOptionCount={SORT_OPTIONS.length}
        dataAttr="communication-filter-sort-trigger"
      >
        <FilterSingleSelectList
          options={SORT_OPTIONS}
          value={draftListSort}
          onChange={(value) => setDraftListSort(value as CommunicationListSort)}
          dataAttr="communication-filter-sort"
        />
      </FilterCollapsibleSection>
    </FilterFieldsAccordion>
  );
}
