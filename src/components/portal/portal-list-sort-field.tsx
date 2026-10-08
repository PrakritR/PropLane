"use client";

import {
  FilterCollapsibleSection,
  FilterSingleSelectList,
  filterSingleSelectSummary,
  useFilterAccordionClose,
} from "@/components/portal/filter-field-lists";

/**
 * "Sort by" for a Filter popover: one dropdown, the default option first.
 * Residents and Applications offer House (grouped, the default), Name and
 * Recently updated (both a flat list).
 */
export function PortalListSortField<V extends string>({
  value,
  options,
  defaultValue,
  onChange,
  dataAttr = "portal-filter-sort",
}: {
  value: V;
  options: readonly { value: V; label: string }[];
  defaultValue: V;
  onChange: (next: V) => void;
  dataAttr?: string;
}) {
  const closeFieldMenu = useFilterAccordionClose();
  const asOptions = options.map((option) => ({ value: option.value as string, label: option.label }));
  return (
    <FilterCollapsibleSection
      sectionId="sort-by"
      label="Sort by"
      summary={filterSingleSelectSummary(value, asOptions, asOptions[0]?.label ?? "")}
      empty={value === defaultValue}
      menuOptionCount={asOptions.length}
      dataAttr={`${dataAttr}-trigger`}
    >
      <FilterSingleSelectList
        options={asOptions}
        value={value}
        onChange={(next) => onChange(next as V)}
        onPick={closeFieldMenu}
        dataAttr={dataAttr}
      />
    </FilterCollapsibleSection>
  );
}
