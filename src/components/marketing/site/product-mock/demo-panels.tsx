"use client";

/**
 * The home page demo's contract with its panels: every portal tab the guided
 * demo can open, and one component that draws it. The demo engine owns the
 * window frame, the sidebar and the stage tabs; `DemoPanel` renders only the
 * portal screen itself (inside `BarePanelChrome`, so the lifecycle rows'
 * window chrome and sidebar are left out), fed the shared fixtures. Nothing
 * here saves, fetches or navigates.
 */

import type { ReactNode } from "react";
import { BarePanelChrome } from "@/components/marketing/site/product-mock/shared";
import {
  ApplicationsPanel,
  CommunicationPanel,
  DashboardPanel,
  LeasesPanel,
  PaymentsPanel,
  ServicesPanel,
  ToursPanel,
} from "@/components/marketing/site/product-mock/panels";
import { CalendarPanel, PropertiesPanel, ResidentsPanel, VendorsPanel } from "@/components/marketing/site/product-mock/panels-manager-more";
import {
  ResidentApplicationsPanel,
  ResidentCommunicationPanel,
  ResidentFormsPanel,
  ResidentHomePanel,
  ResidentLeasePanel,
  ResidentPaymentsPanel,
  ResidentServicesPanel,
} from "@/components/marketing/site/product-mock/panels-resident";
import {
  VendorCalendarPanel,
  VendorCommunicationPanel,
  VendorPaymentsPanel,
  VendorReviewsPanel,
  VendorServicesPanel,
} from "@/components/marketing/site/product-mock/panels-vendor";

export type DemoPortal = "manager" | "resident" | "vendor";
export type DemoTab = { id: string; label: string; group?: string };

export const DEMO_TABS: Record<DemoPortal, DemoTab[]> = {
  manager: [
    { id: "dashboard", label: "Dashboard" },
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

const PANELS: Record<DemoPortal, Record<string, () => ReactNode>> = {
  manager: {
    dashboard: () => <DashboardPanel />,
    properties: () => <PropertiesPanel />,
    tours: () => <ToursPanel />,
    applications: () => <ApplicationsPanel />,
    leases: () => <LeasesPanel />,
    residents: () => <ResidentsPanel />,
    payments: () => <PaymentsPanel />,
    services: () => <ServicesPanel />,
    calendar: () => <CalendarPanel />,
    communication: () => <CommunicationPanel />,
    vendors: () => <VendorsPanel />,
  },
  resident: {
    home: () => <ResidentHomePanel />,
    applications: () => <ResidentApplicationsPanel />,
    lease: () => <ResidentLeasePanel />,
    payments: () => <ResidentPaymentsPanel />,
    services: () => <ResidentServicesPanel />,
    forms: () => <ResidentFormsPanel />,
    communication: () => <ResidentCommunicationPanel />,
  },
  vendor: {
    services: () => <VendorServicesPanel />,
    calendar: () => <VendorCalendarPanel />,
    payments: () => <VendorPaymentsPanel />,
    reviews: () => <VendorReviewsPanel />,
    communication: () => <VendorCommunicationPanel />,
  },
};

/** The portal screen for one tab, fed fixtures. An unknown tab falls back to
 * that portal's first, so the demo never renders an empty frame. */
export function DemoPanel({ portal, tab }: { portal: DemoPortal; tab: string }) {
  const panels = PANELS[portal];
  const render = panels[tab] ?? panels[DEMO_TABS[portal][0]!.id]!;
  return (
    <BarePanelChrome key={`${portal}:${tab}`}>
      {render()}
    </BarePanelChrome>
  );
}
