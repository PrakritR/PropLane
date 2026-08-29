"use client";

import { ApplicationFilterSortFields } from "@/components/portal/application-filter-sort-fields";
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
  type ManagerTaskListFilterId,
} from "@/lib/manager-task-display";
import type { ManagerTaskListTabId } from "@/lib/portal-detail-routes";
import { usePortalFilterDraft } from "@/lib/portal-filter-draft";

function taskListFilterOptions(tabId: ManagerTaskListTabId) {
  return MANAGER_TASK_LIST_FILTERS.filter(
    (id) => tabId === "in-progress" || id !== "service_orders",
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
}: {
  listFilter: ManagerTaskListFilterId;
  onListFilterChange: (next: ManagerTaskListFilterId) => void;
  tabId: ManagerTaskListTabId;
  propertyOptions: { id: string; label: string }[];
  propertyFilterId: string;
  onPropertyFilterIdChange: (next: string) => void;
}) {
  const propertyFilters = propertyFilterId ? [propertyFilterId] : [];

  return (
    <FilterFieldsAccordion>
      <TaskCategoryFilterFields
        listFilter={listFilter}
        onListFilterChange={onListFilterChange}
        tabId={tabId}
      />
      {propertyOptions.length > 1 ? (
        <ApplicationFilterSortFields
          propertyOptions={propertyOptions}
          propertyFilters={propertyFilters}
          onPropertyFiltersChange={(next) => onPropertyFilterIdChange(next[0] ?? "")}
          allLabel="All houses"
          dataAttr="tasks-filter-property"
          selectionMode="single"
        />
      ) : null}
    </FilterFieldsAccordion>
  );
}
