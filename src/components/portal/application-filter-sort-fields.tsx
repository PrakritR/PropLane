"use client";

import {
  FilterCheckboxList,
  FilterCollapsibleSection,
  FilterFieldsAccordion,
  FilterSingleSelectList,
  filterMultiSelectSummary,
  filterSingleSelectSummary,
  useFilterAccordionClose,
} from "@/components/portal/filter-field-lists";
import { usePortalFilterDraft } from "@/lib/portal-filter-draft";

export function ApplicationFilterSortFields({
  propertyOptions,
  propertyFilters,
  onPropertyFiltersChange,
  allLabel = "All properties",
  dataAttr = "applications-filter-property",
  selectionMode = "multi",
}: {
  propertyOptions: { id: string; label: string }[];
  propertyFilters: string[];
  onPropertyFiltersChange: (next: string[]) => void;
  allLabel?: string;
  dataAttr?: string;
  selectionMode?: "single" | "multi";
}) {
  return (
    <FilterFieldsAccordion>
      <ApplicationFilterSortFieldsBody
        propertyOptions={propertyOptions}
        propertyFilters={propertyFilters}
        onPropertyFiltersChange={onPropertyFiltersChange}
        allLabel={allLabel}
        dataAttr={dataAttr}
        selectionMode={selectionMode}
      />
    </FilterFieldsAccordion>
  );
}

function ApplicationFilterSortFieldsBody({
  propertyOptions,
  propertyFilters,
  onPropertyFiltersChange,
  allLabel,
  dataAttr,
  selectionMode,
}: {
  propertyOptions: { id: string; label: string }[];
  propertyFilters: string[];
  onPropertyFiltersChange: (next: string[]) => void;
  allLabel: string;
  dataAttr: string;
  selectionMode: "single" | "multi";
}) {
  const closeFieldMenu = useFilterAccordionClose();
  const options = propertyOptions.map((option) => ({ value: option.id, label: option.label }));

  if (selectionMode === "single") {
    const summary = filterSingleSelectSummary(
      propertyFilters[0] ?? "",
      [{ value: "", label: allLabel }, ...options],
      allLabel,
    );
    return (
      <FilterCollapsibleSection
        sectionId="property"
        label="Property"
        summary={summary}
        empty={propertyFilters.length === 0}
        menuOptionCount={options.length + 1}
        dataAttr={`${dataAttr}-trigger`}
      >
        <FilterSingleSelectList
          options={[{ value: "", label: allLabel }, ...options]}
          value={propertyFilters[0] ?? ""}
          onChange={(next) => onPropertyFiltersChange(next ? [next] : [])}
          onPick={closeFieldMenu}
          dataAttr={dataAttr}
        />
      </FilterCollapsibleSection>
    );
  }

  const [draftPropertyFilters, setDraftPropertyFilters] = usePortalFilterDraft(
    propertyFilters,
    onPropertyFiltersChange,
    [],
  );
  const summary = filterMultiSelectSummary(draftPropertyFilters, options, allLabel);

  return (
    <FilterCollapsibleSection
      sectionId="property"
      label="Property"
      summary={summary}
      empty={draftPropertyFilters.length === 0}
      menuOptionCount={options.length}
      dataAttr={`${dataAttr}-trigger`}
    >
      <FilterCheckboxList
        options={options}
        selected={draftPropertyFilters}
        onChange={setDraftPropertyFilters}
        emptyMenuText="No properties"
        dataAttr={dataAttr}
      />
    </FilterCollapsibleSection>
  );
}
