"use client";

import { useEffect, useState } from "react";
import { Plug } from "lucide-react";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { usePaidPortalBasePath } from "@/lib/portal-base-path-client";
import { managerIntegrationsHref, type ManagerIntegrationsSection } from "@/lib/portal-settings-section";

/**
 * The Integrations icon in a manager page's header band. It opens Settings -> Integrations
 * scrolled to the section this page's data comes from (`managerIntegrationsHref`), the same way a
 * settings gear navigates to a real page and never opens a pop-up. The word "Integrations" is the
 * tooltip and aria-label only. /demo has no Integrations page, so it draws nothing there.
 */
export function ManagerIntegrationsAction({
  section,
  dataAttr,
}: {
  section: ManagerIntegrationsSection;
  dataAttr?: string;
}) {
  const navigate = usePortalNavigate();
  const href = managerIntegrationsHref(section, usePaidPortalBasePath());
  // `isDemoModeActive()` reads the browser, so it cannot be answered while the
  // server renders: null until the check resolves, never an icon that appears
  // and then disappears on a /demo page.
  const [demo, setDemo] = useState<boolean | null>(null);
  useEffect(() => {
    queueMicrotask(() => setDemo(isDemoModeActive()));
  }, []);
  if (demo !== false) return null;
  return (
    <PortalIconAction
      icon={Plug}
      label="Integrations"
      data-attr={dataAttr ?? `manager-integrations-${section}`}
      data-integrations-target={href}
      onClick={() => navigate(href)}
    />
  );
}
