"use client";

import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PORTAL_TOOLBAR_PILL_BUTTON, PORTAL_TOOLBAR_PILL_BUTTON_ACTIVE } from "@/components/portal/portal-metrics";
import { LocalDestinationNav, type LocalDestinationNavItem } from "@/components/ui/destination-nav";

export type FormAutomationPane = "form" | "automation";

const PANES: { id: FormAutomationPane; label: string }[] = [
  { id: "form", label: "Form" },
  { id: "automation", label: "Automation" },
];

/**
 * Bookings-style command bar for a property Application / Lease page:
 * Form | Automation, optional filter, and the filled +. It carries no settings
 * gear: Settings is a page (Settings → Automations), never a pop-up.
 */
export function PropertyFormAutomationCommandBar({
  pane,
  onPaneChange,
  filter,
  onAdd,
  addLabel,
  addDataAttr,
  addIcon,
  activeFilterChips,
  panes = PANES,
  search,
  stayTabs,
}: {
  pane: FormAutomationPane;
  onPaneChange: (pane: FormAutomationPane) => void;
  filter?: ReactNode;
  activeFilterChips?: ReactNode;
  search?: {
    value: string;
    onChange: (next: string) => void;
    placeholder: string;
    dataAttr: string;
  };
  onAdd: () => void;
  addLabel: string;
  addDataAttr: string;
  addIcon?: LucideIcon;
  /**
   * C228: the property record page dropped its own inline Automation pane
   * (that content moved onto the form itself, in Settings -> Forms), so it
   * passes just `[{ id: "form", ... }]` here — a single destination renders
   * as a plain header, no dead second tab. The generic settings-gear modal
   * (`FormAutomationPaneSwitch`) is untouched and still offers both.
   */
  panes?: { id: FormAutomationPane; label: string }[];
  /**
   * Property record Applications / Leases header: the Long term · Short term tabs (counts included),
   * built by the caller from `property-stay-tabs.ts` so a stay's tab hides identically everywhere.
   * There is no Default tab — a stay's default is a row inside its own list.
   */
  stayTabs?: {
    items: LocalDestinationNavItem[];
    activeId: string;
    onChange: (id: string) => void;
    ariaLabel: string;
  };
}) {
  const destinationRow = stayTabs
    ? (
        <LocalDestinationNav
          items={stayTabs.items}
          activeId={stayTabs.activeId}
          onChange={stayTabs.onChange}
          ariaLabel={stayTabs.ariaLabel}
          appearance="command"
        />
      )
    : panes.length > 1
      ? (
          <LocalDestinationNav
            items={panes.map((item) => ({
              id: item.id,
              label: item.label,
              dataAttr: `property-form-automation-${item.id}`,
            }))}
            activeId={pane}
            onChange={(id) => onPaneChange(id as FormAutomationPane)}
            ariaLabel="Form or automation"
            appearance="command"
          />
        )
      : undefined;

  return (
    <PortalListControlStack
      className="mb-2 max-lg:mb-1.5"
      variant="command"
      destinationRow={destinationRow}
      activeDestinationId={stayTabs?.activeId ?? pane}
      destinationAriaLabel={stayTabs?.ariaLabel ?? "Form or automation"}
      search={search}
      actions={
        filter
      }
      primary={
        <PortalPrimaryIconAction
          label={addLabel}
          icon={addIcon}
          data-attr={addDataAttr}
          onClick={onAdd}
        />
      }
      activeFilterChips={activeFilterChips}
    />
  );
}

/** Form | Automation pills used by the settings sheet and the Settings hub. */
export function FormAutomationPaneSwitch({
  pane,
  onChange,
}: {
  pane: FormAutomationPane;
  onChange: (pane: FormAutomationPane) => void;
}) {
  return (
    <div className="mb-4 flex flex-wrap gap-1.5">
      {PANES.map((item) => (
        <button
          key={item.id}
          type="button"
          className={pane === item.id ? PORTAL_TOOLBAR_PILL_BUTTON_ACTIVE : PORTAL_TOOLBAR_PILL_BUTTON}
          data-attr={`manager-settings-pane-${item.id}`}
          onClick={() => onChange(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
