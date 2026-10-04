"use client";

import { Settings } from "lucide-react";
import { PortalIconAction, PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalFilterSortSheet } from "@/components/portal/portal-filter-sort-sheet";
import { CheckboxMultiSelect, type CheckboxMultiSelectOption } from "@/components/ui/checkbox-multi-select";
import { LocalDestinationNav } from "@/components/ui/destination-nav";

/** A section's status checklist inside its Filter popover — same shape everywhere. */
export type PortalPropertySectionFilterConfig = {
  /** The field label inside the Filter popover (e.g. "Status"). */
  label: string;
  options: CheckboxMultiSelectOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  dataAttr: string;
};

/**
 * The one property-section header card (PLAN "6. property sections", captain
 * 2026-09-27: "update service ui to have top bar. filter setting + always
 * throughout all sections in property") — Filter · Settings gear · round blue +,
 * built on the same {@link PortalListControlStack} command band every list page
 * uses, so it is pixel-for-pixel the list-page header card. Any of the three
 * controls may be omitted when the section genuinely has nothing to back it
 * (Activity has no gear or +; a section with no per-property settings gets no
 * gear rather than a fabricated one).
 */
export function PortalPropertySectionToolbar({
  tab,
  filter,
  onSettings,
  settingsLabel = "Settings",
  settingsDataAttr,
  onAdd,
  addLabel = "Add",
  addDataAttr,
  className,
}: {
  /** The band's one text tab, "Activity 3" — what every other tab's band leads with. */
  tab?: { id: string; label: string; count: number };
  filter?: PortalPropertySectionFilterConfig;
  onSettings?: () => void;
  settingsLabel?: string;
  settingsDataAttr?: string;
  onAdd?: () => void;
  addLabel?: string;
  addDataAttr?: string;
  className?: string;
}) {
  const activeCount = filter && filter.selected.length > 0 && filter.selected.length < filter.options.length ? 1 : 0;

  const filterRow = filter ? (
    <PortalFilterSortSheet
      activeCount={activeCount}
      compactPanel
      commandStripTrigger
      dropdownAlign="start"
      filterFieldCount={1}
      mobileFlushBody
      onReset={() => filter.onChange(filter.options.map((option) => option.value))}
      dataAttr={filter.dataAttr}
    >
      <CheckboxMultiSelect
        label={filter.label}
        options={filter.options}
        selected={filter.selected}
        onChange={filter.onChange}
        dataAttr={`${filter.dataAttr}-field`}
      />
    </PortalFilterSortSheet>
  ) : undefined;

  return (
    <PortalListControlStack
      className={className ?? "mb-2 max-lg:mb-1.5"}
      variant="command"
      filterRow={filterRow}
      destinationRow={
        tab ? (
          <LocalDestinationNav
            appearance="command"
            items={[{ id: tab.id, label: tab.label, count: tab.count, dataAttr: `property-section-tab-${tab.id}` }]}
            activeId={tab.id}
            onChange={() => {}}
            ariaLabel={tab.label}
          />
        ) : undefined
      }
      activeDestinationId={tab?.id}
      actions={
        onSettings ? (
          <PortalIconAction
            icon={Settings}
            label={settingsLabel}
            data-attr={settingsDataAttr}
            onClick={onSettings}
          />
        ) : undefined
      }
      primary={
        onAdd ? (
          <PortalPrimaryIconAction label={addLabel} data-attr={addDataAttr} onClick={onAdd} />
        ) : undefined
      }
    />
  );
}

PortalPropertySectionToolbar.displayName = "PortalPropertySectionToolbar";
