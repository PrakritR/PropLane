"use client";

/**
 * Shared panel contract for the home page's guided demo (captain 2026-10-06).
 *
 * The demo engine (`resident-lifecycle-prototypes.tsx`) only knows this file's
 * three exports: the tab lists per portal, and `DemoPanel`, which renders the
 * real portal screen for one tab. This is the MINIMAL version so the demo
 * compiles: manager tabs map to the existing static panels in `panels.tsx`,
 * every other tab renders a neutral placeholder. The full version (windowless
 * panels for every manager, resident and vendor tab) replaces this file.
 */

import type { ReactNode } from "react";
import {
  ApplicationsPanel,
  CommunicationPanel,
  DashboardPanel,
  LeasesPanel,
  PaymentsPanel,
  ServicesPanel,
  ToursPanel,
} from "@/components/marketing/site/product-mock/panels";

export type DemoPortal = "manager" | "resident" | "vendor";
export type DemoTab = { id: string; label: string; group?: string };

export const DEMO_TABS: Record<DemoPortal, DemoTab[]> = {
  manager: [
    { id: "dashboard", label: "Dashboard", group: "WORKSPACE" },
    { id: "properties", label: "Properties", group: "WORKSPACE" },
    { id: "tours", label: "Tours", group: "LEASING" },
    { id: "applications", label: "Applications", group: "LEASING" },
    { id: "leases", label: "Leases", group: "LEASING" },
    { id: "residents", label: "Residents", group: "TENANCY" },
    { id: "payments", label: "Payments", group: "TENANCY" },
    { id: "services", label: "Services", group: "TENANCY" },
    { id: "calendar", label: "Calendar", group: "OPERATIONS" },
    { id: "communication", label: "Communication", group: "OPERATIONS" },
    { id: "vendors", label: "Vendors", group: "OPERATIONS" },
  ],
  resident: [
    { id: "home", label: "My home" },
    { id: "applications", label: "Applications" },
    { id: "lease", label: "Lease" },
    { id: "payments", label: "Payments" },
    { id: "services", label: "Services" },
    { id: "forms", label: "Forms" },
    { id: "communication", label: "Communication" },
  ],
  vendor: [
    { id: "services", label: "Services" },
    { id: "calendar", label: "Calendar" },
    { id: "payments", label: "Payments" },
    { id: "reviews", label: "Reviews" },
    { id: "communication", label: "Communication" },
  ],
};

const MANAGER_PANELS: Record<string, () => ReactNode> = {
  dashboard: () => <DashboardPanel />,
  tours: () => <ToursPanel />,
  applications: () => <ApplicationsPanel />,
  leases: () => <LeasesPanel />,
  payments: () => <PaymentsPanel />,
  services: () => <ServicesPanel />,
  communication: () => <CommunicationPanel />,
};

export function DemoPanel({ portal, tab }: { portal: DemoPortal; tab: string }) {
  const render = portal === "manager" ? MANAGER_PANELS[tab] : undefined;
  if (render) {
    return (
      <div className="relative w-full overflow-hidden" style={{ aspectRatio: "1280 / 780" }}>
        {render()}
      </div>
    );
  }
  const label = DEMO_TABS[portal].find((item) => item.id === tab)?.label ?? tab;
  return (
    <div role="status" className="grid min-h-[320px] w-full place-items-center p-8 text-center text-[13px] text-muted">
      Loading the {label.toLowerCase()} sample
    </div>
  );
}
