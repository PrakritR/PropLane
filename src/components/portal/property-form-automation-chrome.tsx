"use client";

import { Settings, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { PortalIconAction, PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PORTAL_TOOLBAR_PILL_BUTTON, PORTAL_TOOLBAR_PILL_BUTTON_ACTIVE } from "@/components/portal/portal-metrics";
import { LocalDestinationNav } from "@/components/ui/destination-nav";

export type FormAutomationPane = "form" | "automation";

const PANES: { id: FormAutomationPane; label: string }[] = [
  { id: "form", label: "Form" },
  { id: "automation", label: "Automation" },
];

/**
 * Bookings-style command bar for a property Application / Lease page:
 * Form | Automation, optional filter, gear, and the filled +.
 */
export function PropertyFormAutomationCommandBar({
  pane,
  onPaneChange,
  filter,
  onSettings,
  settingsLabel,
  settingsDataAttr,
  settingsDisabled,
  onAdd,
  addLabel,
  addDataAttr,
  addIcon,
  activeFilterChips,
  panes = PANES,
}: {
  pane: FormAutomationPane;
  onPaneChange: (pane: FormAutomationPane) => void;
  filter?: ReactNode;
  activeFilterChips?: ReactNode;
  onSettings: () => void;
  settingsLabel: string;
  settingsDataAttr: string;
  settingsDisabled?: boolean;
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
}) {
  return (
    <PortalListControlStack
      className="mb-2 max-lg:mb-1.5"
      variant="command"
      destinationRow={
        panes.length > 1 ? (
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
        ) : undefined
      }
      activeDestinationId={pane}
      destinationAriaLabel="Form or automation"
      actions={
        <>
          {filter}
          <PortalIconAction
            icon={Settings}
            label={settingsLabel}
            data-attr={settingsDataAttr}
            disabled={settingsDisabled}
            onClick={onSettings}
          />
        </>
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
