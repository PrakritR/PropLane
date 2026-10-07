"use client";

import { Settings } from "lucide-react";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { vendorListGearHref, type VendorListGearSection } from "@/lib/portals/vendor-settings-pages";

/**
 * The gear in a vendor list band. It opens the matching vendor Settings page
 * (Services → Trades & service area, Payments → Payouts, Reviews → Profile,
 * Communication → Quick replies) — a real page in the Settings rail, never a
 * local pop-up.
 */
export function VendorSettingsGear({
  section,
  label,
  basePath = "/vendor",
  dataAttr,
}: {
  section: VendorListGearSection;
  label: string;
  basePath?: string;
  dataAttr?: string;
}) {
  const navigate = usePortalNavigate();
  return (
    <PortalIconAction
      icon={Settings}
      label={label}
      data-attr={dataAttr ?? `vendor-${section}-settings-gear`}
      data-gear-target={vendorListGearHref(section, basePath)}
      onClick={() => navigate(vendorListGearHref(section, basePath))}
    />
  );
}
