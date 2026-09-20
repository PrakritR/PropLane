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
}) {
  return (
    <PortalListControlStack
      className="mb-2 max-lg:mb-1.5"
      variant="command"
      destinationRow={
        <LocalDestinationNav
          items={PANES.map((item) => ({
            id: item.id,
            label: item.label,
            dataAttr: `property-form-automation-${item.id}`,
          }))}
          activeId={pane}
          onChange={(id) => onPaneChange(id as FormAutomationPane)}
          ariaLabel="Form or automation"
          appearance="command"
        />
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
