"use client";

import {
  PortalListGroupModeField,
  PortalListPropertyField,
} from "@/components/portal/portal-list-group-filter-fields";
import {
  FilterCollapsibleSection,
  FilterFieldsAccordion,
  FilterSingleSelectList,
  filterSingleSelectSummary,
  useFilterAccordionClose,
} from "@/components/portal/filter-field-lists";
import {
  MANAGER_TASK_LIST_FILTER_LABELS,
  MANAGER_TASK_LIST_FILTERS,
  MANAGER_TASK_LIST_SORT_LABELS,
  MANAGER_TASK_LIST_SORTS,
  type ManagerTaskListFilterId,
  type ManagerTaskListSortId,
} from "@/lib/manager-task-display";
import type { PortalListGroupMode } from "@/lib/portal-list-grouping";
import type { ManagerTaskListTabId } from "@/lib/portal-detail-routes";
import { usePortalFilterDraft } from "@/lib/portal-filter-draft";

function taskListFilterOptions(tabId: ManagerTaskListTabId) {
  return MANAGER_TASK_LIST_FILTERS.filter(
    (id) => (tabId === "in-progress" || id !== "service_orders"),
  ).map(
    (id) => ({
      value: id,
      label: MANAGER_TASK_LIST_FILTER_LABELS[id],
    }),
  );
}

function TaskCategoryFilterFields({
  listFilter,
  onListFilterChange,
  tabId,
}: {
  listFilter: ManagerTaskListFilterId;
  onListFilterChange: (next: ManagerTaskListFilterId) => void;
  tabId: ManagerTaskListTabId;
}) {
  const closeFieldMenu = useFilterAccordionClose();
  const [draftFilter, setDraftFilter] = usePortalFilterDraft(listFilter, onListFilterChange, "all");
  const options = taskListFilterOptions(tabId);
  const summary = filterSingleSelectSummary(draftFilter, options, "All");

  return (
    <FilterCollapsibleSection
      sectionId="category"
      label="Type"
      summary={summary}
      empty={draftFilter === "all"}
      menuOptionCount={options.length}
      dataAttr="tasks-filter-category-trigger"
    >
      <FilterSingleSelectList
        options={options}
        value={draftFilter}
        onChange={(next) => setDraftFilter(next as ManagerTaskListFilterId)}
        onPick={closeFieldMenu}
        dataAttr="tasks-filter-category"
      />
    </FilterCollapsibleSection>
  );
}

export function ManagerTaskFilterFields({
  listFilter,
  onListFilterChange,
  tabId,
  propertyOptions,
  propertyFilterId,
  onPropertyFilterIdChange,
  groupMode,
  onGroupModeChange,
  sortId,
  onSortIdChange,
}: {
  listFilter: ManagerTaskListFilterId;
  onListFilterChange: (next: ManagerTaskListFilterId) => void;
  tabId: ManagerTaskListTabId;
  propertyOptions: { id: string; label: string }[];
  propertyFilterId: string;
  onPropertyFilterIdChange: (next: string) => void;
  groupMode: PortalListGroupMode;
  onGroupModeChange: (next: PortalListGroupMode) => void;
  sortId: ManagerTaskListSortId;
  onSortIdChange: (next: ManagerTaskListSortId) => void;
}) {
  const propertyFilters = propertyFilterId ? [propertyFilterId] : [];
  const sortOptions = MANAGER_TASK_LIST_SORTS.map((id) => ({
    value: id,
    label: MANAGER_TASK_LIST_SORT_LABELS[id],
  }));
  const [draftSortId, setDraftSortId] = usePortalFilterDraft(sortId, onSortIdChange, "due_soonest");

  return (
    <FilterFieldsAccordion>
      {/* Group by leads, then Sort by, then the rest — the same order on every
          portal list, so the two controls that reshape the list are always the
          first things read. */}
      <PortalListGroupModeField
        groupMode={groupMode}
        onGroupModeChange={onGroupModeChange}
        dataAttr="tasks-filter-group-mode"
      />
      <FilterCollapsibleSection
        sectionId="sort"
        label="Sort by"
        summary={filterSingleSelectSummary(draftSortId, sortOptions, "Due soonest")}
        empty={draftSortId === "due_soonest"}
        menuOptionCount={sortOptions.length}
        dataAttr="tasks-filter-sort-trigger"
      >
        <FilterSingleSelectList
          options={sortOptions}
          value={draftSortId}
          onChange={(next) => setDraftSortId(next as ManagerTaskListSortId)}
          dataAttr="tasks-filter-sort"
        />
      </FilterCollapsibleSection>
      <TaskCategoryFilterFields
        listFilter={listFilter}
        onListFilterChange={onListFilterChange}
        tabId={tabId}
      />
      {propertyOptions.length > 1 ? (
        <PortalListPropertyField
          propertyOptions={propertyOptions}
          propertyFilters={propertyFilters}
          onPropertyFiltersChange={(next) => onPropertyFilterIdChange(next[0] ?? "")}
          propertyAllLabel="All houses"
          propertyDataAttr="tasks-filter-property"
        />
      ) : null}
    </FilterFieldsAccordion>
  );
}
