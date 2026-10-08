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
import {
  PORTAL_FILTER_DRAFT_PROPERTY_FILTERS,
  usePortalFilterDraft,
} from "@/lib/portal-filter-draft";

export function ApplicationFilterSortFields({
  propertyOptions,
  propertyFilters,
  onPropertyFiltersChange,
  allLabel = "All properties",
  dataAttr = "applications-filter-property",
  selectionMode = "multi",
  label = "Property",
}: {
  propertyOptions: { id: string; label: string }[];
  propertyFilters: string[];
  onPropertyFiltersChange: (next: string[]) => void;
  allLabel?: string;
  dataAttr?: string;
  selectionMode?: "single" | "multi";
  /** The field's label: "Property" everywhere, "House" on the lists grouped by house. */
  label?: string;
}) {
  return (
    <FilterFieldsAccordion>
      {selectionMode === "single" ? (
        <ApplicationFilterSortFieldsSingle
          propertyOptions={propertyOptions}
          propertyFilters={propertyFilters}
          onPropertyFiltersChange={onPropertyFiltersChange}
          allLabel={allLabel}
          dataAttr={dataAttr}
          label={label}
        />
      ) : (
        <ApplicationFilterSortFieldsMulti
          propertyOptions={propertyOptions}
          propertyFilters={propertyFilters}
          onPropertyFiltersChange={onPropertyFiltersChange}
          allLabel={allLabel}
          dataAttr={dataAttr}
          label={label}
        />
      )}
    </FilterFieldsAccordion>
  );
}

function ApplicationFilterSortFieldsSingle({
  propertyOptions,
  propertyFilters,
  onPropertyFiltersChange,
  allLabel,
  dataAttr,
  label,
}: {
  propertyOptions: { id: string; label: string }[];
  propertyFilters: string[];
  onPropertyFiltersChange: (next: string[]) => void;
  allLabel: string;
  dataAttr: string;
  label: string;
}) {
  const closeFieldMenu = useFilterAccordionClose();
  const options = propertyOptions.map((option) => ({ value: option.id, label: option.label }));
  const summary = filterSingleSelectSummary(
    propertyFilters[0] ?? "",
    [{ value: "", label: allLabel }, ...options],
    allLabel,
  );

  return (
    <FilterCollapsibleSection
      sectionId="property"
      label={label}
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

function ApplicationFilterSortFieldsMulti({
  propertyOptions,
  propertyFilters,
  onPropertyFiltersChange,
  allLabel,
  dataAttr,
  label,
}: {
  propertyOptions: { id: string; label: string }[];
  propertyFilters: string[];
  onPropertyFiltersChange: (next: string[]) => void;
  allLabel: string;
  dataAttr: string;
  label: string;
}) {
  const [draftPropertyFilters, setDraftPropertyFilters] = usePortalFilterDraft(
    propertyFilters,
    onPropertyFiltersChange,
    [],
    PORTAL_FILTER_DRAFT_PROPERTY_FILTERS,
  );
  const options = propertyOptions.map((option) => ({ value: option.id, label: option.label }));
  const summary = filterMultiSelectSummary(draftPropertyFilters, options, allLabel);

  return (
    <FilterCollapsibleSection
      sectionId="property"
      label={label}
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
