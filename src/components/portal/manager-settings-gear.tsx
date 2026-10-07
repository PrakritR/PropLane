"use client";

import { Settings } from "lucide-react";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { usePaidPortalBasePath } from "@/lib/portal-base-path-client";
import { managerSettingsGearHref, type ManagerSettingsGearTarget } from "@/lib/portal-settings-section";

/**
 * The gear in a manager list band. It opens the matching Settings page and
 * section (`MANAGER_SETTINGS_GEAR_TARGETS`) — a real page in the Settings rail,
 * never a local pop-up. Mirrors the vendor portal's `VendorSettingsGear`.
 */
export function ManagerSettingsGear({
  target,
  label,
  dataAttr,
}: {
  target: ManagerSettingsGearTarget;
  label: string;
  dataAttr?: string;
}) {
  const navigate = usePortalNavigate();
  const href = managerSettingsGearHref(target, usePaidPortalBasePath());
  return (
    <PortalIconAction
      icon={Settings}
      label={label}
      data-attr={dataAttr ?? `manager-${target}-settings-gear`}
      data-gear-target={href}
      onClick={() => navigate(href)}
    />
  );
}
