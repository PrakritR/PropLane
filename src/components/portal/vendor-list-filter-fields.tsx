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
import { Input } from "@/components/ui/input";
import { usePortalFilterDraft } from "@/lib/portal-filter-draft";

const RATING_OPTIONS = [
  { value: "", label: "Any rating" },
  { value: "3", label: "3+ stars" },
  { value: "4", label: "4+ stars" },
  { value: "4.5", label: "4.5+ stars" },
];

/**
 * The Vendors Filter popover. Category (multi-select, "All categories" when none
 * is ticked) narrows both tabs; Area and Rating narrow the PropLane directory,
 * which is the only list whose vendors carry them.
 */
export function VendorListFilterFields({
  categoryOptions,
  categories,
  onCategoriesChange,
  directory,
  area,
  onAreaChange,
  rating,
  onRatingChange,
}: {
  categoryOptions: { value: string; label: string }[];
  categories: string[];
  onCategoriesChange: (next: string[]) => void;
  /** The PropLane vendors tab: adds the Area and Rating fields. */
  directory: boolean;
  area: string;
  onAreaChange: (next: string) => void;
  rating: string;
  onRatingChange: (next: string) => void;
}) {
  const closeFieldMenu = useFilterAccordionClose();
  const [draftCategories, setDraftCategories] = usePortalFilterDraft(categories, onCategoriesChange, []);
  return (
    <FilterFieldsAccordion>
      <FilterCollapsibleSection
        sectionId="vendor-category"
        label="Category"
        summary={filterMultiSelectSummary(draftCategories, categoryOptions, "All categories")}
        empty={draftCategories.length === 0}
        menuOptionCount={categoryOptions.length}
        dataAttr="vendors-filter-category-trigger"
      >
        <FilterCheckboxList
          options={categoryOptions}
          selected={draftCategories}
          onChange={setDraftCategories}
          emptyMenuText="No categories"
          dataAttr="vendors-filter-category"
        />
      </FilterCollapsibleSection>
      {directory ? (
        <>
          <div>
            <label
              className="text-xs font-semibold uppercase tracking-wide text-muted"
              htmlFor="vendor-directory-filter-area"
            >
              Area
            </label>
            <Input
              id="vendor-directory-filter-area"
              value={area}
              onChange={(e) => onAreaChange(e.target.value)}
              placeholder="City or ZIP"
              data-attr="vendor-directory-filter-area"
            />
          </div>
          <FilterCollapsibleSection
            sectionId="vendor-rating"
            label="Rating"
            summary={filterSingleSelectSummary(rating, RATING_OPTIONS, "Any rating")}
            empty={!rating}
            menuOptionCount={RATING_OPTIONS.length}
            dataAttr="vendor-directory-filter-rating-trigger"
          >
            <FilterSingleSelectList
              options={RATING_OPTIONS}
              value={rating}
              onChange={onRatingChange}
              onPick={closeFieldMenu}
              dataAttr="vendor-directory-filter-rating"
            />
          </FilterCollapsibleSection>
        </>
      ) : null}
    </FilterFieldsAccordion>
  );
}
