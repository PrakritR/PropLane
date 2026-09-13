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
import {
  type CommunicationFilterRole,
  type CommunicationThreadFilters,
} from "@/lib/communication-thread-filters";
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
}: {
  propertyOptions: { value: string; label: string }[];
  roleOptions: { value: CommunicationFilterRole; label: string }[];
  filters: CommunicationThreadFilters;
  onFiltersChange: (next: CommunicationThreadFilters) => void;
  listSort: CommunicationListSort;
  onListSortChange: (next: CommunicationListSort) => void;
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
      <FilterCollapsibleSection sectionId="status" label="Status"
        summary={draftFilters.status === "read" ? "Read" : draftFilters.status === "unread" ? "Unread" : draftFilters.status === "archived" ? "Archived" : "All conversations"}
        empty={!draftFilters.status || draftFilters.status === "active"} menuOptionCount={4}>
        <FilterSingleSelectList options={[{ value: "active", label: "All conversations" }, { value: "unread", label: "Unread" }, { value: "read", label: "Read" }, { value: "archived", label: "Archived" }]}
          value={draftFilters.status ?? "active"} onChange={(value) => setDraftFilters({ ...draftFilters, status: value as CommunicationThreadFilters["status"] })} dataAttr="communication-filter-status" />
      </FilterCollapsibleSection>
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
