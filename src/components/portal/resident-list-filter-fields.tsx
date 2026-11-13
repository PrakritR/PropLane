"use client";

import {
  FilterCollapsibleSection,
  FilterSingleSelectList,
  filterSingleSelectSummary,
  useFilterAccordionClose,
} from "@/components/portal/filter-field-lists";
import { usePortalFilterDraft } from "@/lib/portal-filter-draft";
import {
  RESIDENT_CONTACT_FILTER_DEFAULT,
  RESIDENT_CONTACT_FILTER_OPTIONS,
  RESIDENT_STAY_FILTER_DEFAULT,
  RESIDENT_STAY_FILTER_OPTIONS,
  type ResidentContactFilter,
  type ResidentStayFilter,
} from "@/lib/resident-list-filters";

/** Residents Filter: Stay (Long-term by default) and Contact (Missing phone). Dropdowns, never chips. */
export function ResidentStayFilterField({
  value,
  onChange,
}: {
  value: ResidentStayFilter;
  onChange: (next: ResidentStayFilter) => void;
}) {
  const closeFieldMenu = useFilterAccordionClose();
  const [draft, setDraft] = usePortalFilterDraft<ResidentStayFilter>(value, onChange, RESIDENT_STAY_FILTER_DEFAULT, "residentStay");
  return (
    <FilterCollapsibleSection
      sectionId="stay"
      label="Stay"
      summary={filterSingleSelectSummary(draft, RESIDENT_STAY_FILTER_OPTIONS, "Long-term")}
      empty={draft === RESIDENT_STAY_FILTER_DEFAULT}
      menuOptionCount={RESIDENT_STAY_FILTER_OPTIONS.length}
      dataAttr="residents-filter-stay-trigger"
    >
      <FilterSingleSelectList
        options={RESIDENT_STAY_FILTER_OPTIONS}
        value={draft}
        onChange={(next) => setDraft(next as ResidentStayFilter)}
        onPick={closeFieldMenu}
        dataAttr="residents-filter-stay"
      />
    </FilterCollapsibleSection>
  );
}

export function ResidentContactFilterField({
  value,
  onChange,
}: {
  value: ResidentContactFilter;
  onChange: (next: ResidentContactFilter) => void;
}) {
  const closeFieldMenu = useFilterAccordionClose();
  const [draft, setDraft] = usePortalFilterDraft<ResidentContactFilter>(value, onChange, RESIDENT_CONTACT_FILTER_DEFAULT, "residentContact");
  return (
    <FilterCollapsibleSection
      sectionId="contact"
      label="Contact"
      summary={filterSingleSelectSummary(draft, RESIDENT_CONTACT_FILTER_OPTIONS, "Everyone")}
      empty={draft === RESIDENT_CONTACT_FILTER_DEFAULT}
      menuOptionCount={RESIDENT_CONTACT_FILTER_OPTIONS.length}
      dataAttr="residents-filter-contact-trigger"
    >
      <FilterSingleSelectList
        options={RESIDENT_CONTACT_FILTER_OPTIONS}
        value={draft}
        onChange={(next) => setDraft(next as ResidentContactFilter)}
        onPick={closeFieldMenu}
        dataAttr="residents-filter-contact"
      />
    </FilterCollapsibleSection>
  );
}
