"use client";

import type { LucideIcon } from "lucide-react";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
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
    node: <PortalIconAction ring ringPrimary={tone === "primary"} icon={icon} label={label} tone={tone} disabled={disabled} data-attr={dataAttr} onClick={() => { onClick(); }} />,
    menuItem: <DropdownMenuItem disabled={disabled} className={tone === "danger" ? "text-red-600" : undefined} data-attr={dataAttr} onSelect={() => { onClick(); }}>{label}</DropdownMenuItem>,
  };
}
