"use client";

import type { ReactNode } from "react";
import { Plus } from "lucide-react";
import { LocalDestinationNav } from "@/components/ui/destination-nav";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import {
  FilterCollapsibleSection,
  FilterFieldsAccordion,
  FilterSingleSelectList,
  filterSingleSelectSummary,
  useFilterAccordionClose,
} from "@/components/portal/filter-field-lists";
import { PortalFilterSortSheet, portalFilterActiveCount } from "@/components/portal/portal-filter-sort-sheet";
import { PORTAL_PROPERTY_FILTER_SHEET_CLASS } from "@/components/portal/portal-filter-shell";

export type RecordListBandTab = { id: string; label: string; count?: number; alert?: boolean };

/** One field of a band's Filter popover: a single-select with an "Any" entry. */
export type RecordBandFilterField = {
  id: string;
  label: string;
  /** The "no filter" entry's wording ("Any type"). */
  anyLabel: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
};

function BandFilterField({ field }: { field: RecordBandFilterField }) {
  const closeFieldMenu = useFilterAccordionClose();
  const options = [{ value: "", label: field.anyLabel }, ...field.options];
  return (
    <FilterCollapsibleSection
      sectionId={field.id}
      label={field.label}
      summary={filterSingleSelectSummary(field.value, options, field.anyLabel)}
      empty={!field.value}
      menuOptionCount={options.length}
      dataAttr={`record-band-filter-${field.id}-trigger`}
    >
      <FilterSingleSelectList options={options} value={field.value} onChange={field.onChange} onPick={closeFieldMenu} dataAttr={`record-band-filter-${field.id}`} />
    </FilterCollapsibleSection>
  );
}

/**
 * The Filter icon + popover of a record band. Only drawn when the list has at least one filterable
 * field (stage, type, vendor, property...); every field really narrows the rows.
 */
export function RecordBandFilter({ fields, dataAttr }: { fields: readonly RecordBandFilterField[]; dataAttr: string }) {
  if (fields.length === 0) return null;
  return (
    <PortalFilterSortSheet
      activeCount={portalFilterActiveCount(fields.map((f) => (f.value ? [f.value] : [])))}
      compactPanel
      commandStripTrigger
      filterFieldCount={fields.length}
      constrainDropdownToTitleBand={false}
      mobileFlushBody
      className={PORTAL_PROPERTY_FILTER_SHEET_CLASS}
      onReset={() => fields.forEach((f) => f.onChange(""))}
      dataAttr={`${dataAttr}-filter`}
    >
      <FilterFieldsAccordion>
        {fields.map((field) => (
          <BandFilterField key={field.id} field={field} />
        ))}
      </FilterFieldsAccordion>
    </PortalFilterSortSheet>
  );
}

type BandProps = {
  tabs: readonly RecordListBandTab[];
  activeId: string;
  onChange: (id: string) => void;
  ariaLabel: string;
  /** Omitted on a section that is not a list (Service details, Communication). */
  search?: { value: string; onChange: (value: string) => void; placeholder: string };
  /** Icons at the band's top right: Filter, Edit, Assign. Order is the caller's. */
  actions?: ReactNode;
  /** The round blue + - omitted where nothing can be created from this tab. */
  plus?: { label: string; onClick: () => void; dataAttr?: string };
  dataAttr: string;
};

/**
 * THE band every record section opens with - one card holding the tabs (counts when the tab has
 * one, blue underline on the active tab, red for an alert such as Overdue > 0), search where the
 * section is a list, the icons at the top right and the round blue +. It is the Payments header
 * (`PortalListControlStack`, command variant), not a second implementation.
 */
export function RecordTabBand({ tabs, activeId, onChange, ariaLabel, search, actions, plus, dataAttr }: BandProps) {
  return (
    <PortalListControlStack
      variant="command"
      stickyDestinations={false}
      destinationRow={
        <LocalDestinationNav
          appearance="command"
          items={tabs.map((tab) => ({ id: tab.id, label: tab.label, count: tab.count, alert: tab.alert, dataAttr: `${dataAttr}-tab-${tab.id}` }))}
          activeId={activeId}
          onChange={onChange}
          ariaLabel={ariaLabel}
        />
      }
      search={search ? { ...search, dataAttr: `${dataAttr}-search`, ariaLabel: search.placeholder } : undefined}
      actions={actions}
      primary={plus ? <PortalPrimaryIconAction label={plus.label} icon={Plus} data-attr={plus.dataAttr ?? `${dataAttr}-plus`} onClick={plus.onClick} /> : undefined}
    />
  );
}

/** The band for a LIST tab: the band, optional cards under it, then the rows or the one standard empty card. */
export function RecordListBand({
  middle,
  isEmpty,
  emptyTitle,
  emptySection = "services",
  loading = false,
  children,
  ...band
}: BandProps & {
  /** Content between the band and the rows (a progress line, the assigned vendor). */
  middle?: ReactNode;
  isEmpty: boolean;
  /** The standard empty card's title, drawn UNDER the band. */
  emptyTitle: string;
  emptySection?: string;
  loading?: boolean;
  children: ReactNode;
}) {
  return (
    <div data-attr={band.dataAttr} className="pb-6">
      <RecordTabBand {...band} />
      {middle}
      <PortalRecordListSurface loading={loading} isEmpty={isEmpty} emptyCard={{ title: emptyTitle, section: emptySection }}>
        {children}
      </PortalRecordListSurface>
    </div>
  );
}
