"use client";

import { useEffect } from "react";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { vendorListGearHref, type VendorListGearSection } from "@/lib/portals/vendor-settings-pages";

/**
 * Transitional shim. The gear in a vendor list band used to open a local
 * notifications pop-up; it now opens the matching vendor Settings page
 * (`vendor-settings-pages.ts`). Callers that still mount this component with
 * `open` get redirected instead of a pop-up: opening it navigates to the page
 * and immediately closes it. New code should render `VendorSettingsGear`.
 */
export function VendorSectionSettingsModal({
  open,
  title,
  onClose,
  section,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  /** Which list the gear belongs to; falls back to the title (Communication) or Services. */
  section?: VendorListGearSection;
}) {
  const navigate = usePortalNavigate();
  useEffect(() => {
    if (!open) return;
    const target: VendorListGearSection = section ?? (/communication/i.test(title) ? "communication" : "services");
    onClose();
    navigate(vendorListGearHref(target));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return null;
}
