"use client";

import type { LucideIcon } from "lucide-react";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import type { PortalAdaptiveAction } from "@/lib/portal-adaptive-actions";

/** The same authorized handler and disabled state in a header or its overflow. */
export function portalIconActionSpec({ id, label, icon, onClick, disabled, tone, dataAttr }: {
  id: string;
  label: string;
  icon: LucideIcon;
  onClick: () => unknown;
  disabled?: boolean;
  tone?: "default" | "primary" | "danger";
  dataAttr?: string;
}): PortalAdaptiveAction {
  return {
    id, tone,
    node: <PortalIconAction ring ringPrimary={tone === "primary"} icon={icon} label={label} tone={tone} disabled={disabled} data-attr={dataAttr} onClick={onClick} />,
    menuItem: <DropdownMenuItem disabled={disabled} className={tone === "danger" ? "text-red-600" : undefined} data-attr={dataAttr} onSelect={() => onClick()}>{label}</DropdownMenuItem>,
  };
}

/**
 * The ONE labeled primary of a record header (a service's next step: Approve, Mark done...): a filled button
 * with the word on it, at the right edge after the icons. Everything else in that header stays an icon;
 * the primary is the single place a word is drawn, because it is the action the manager most likely wants.
 * The same authorized handler folds into the overflow menu when the row is too narrow.
 */
export function portalLabeledPrimarySpec({ id, label, onClick, disabled, dataAttr, demoTarget }: {
  id: string;
  label: string;
  onClick: () => unknown;
  disabled?: boolean;
  dataAttr?: string;
  /** `data-demo-target` for the home demo's cursor. */
  demoTarget?: string;
}): PortalAdaptiveAction {
  return {
    id,
    tone: "primary",
    node: (
      <Button type="button" variant="primary" className="h-9 shrink-0 rounded-full px-5 text-[13.5px]" aria-label={label} disabled={disabled} data-attr={dataAttr} data-demo-target={demoTarget} data-labeled-primary="" onClick={() => onClick()}>
        {label}
      </Button>
    ),
    menuItem: <DropdownMenuItem disabled={disabled} data-attr={dataAttr} onSelect={() => onClick()}>{label}</DropdownMenuItem>,
  };
}
