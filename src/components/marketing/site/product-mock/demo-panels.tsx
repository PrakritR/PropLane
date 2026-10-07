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
import { phoneScriptFor } from "@/components/marketing/resident-lifecycle-script";
import {
  NO_STORY,
  residentConversations,
  residentStory,
  vendorConversations,
  vendorStory,
  type DemoStory,
} from "@/components/marketing/site/product-mock/world";
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
export type { DemoStory };

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

type PanelProps = { story: DemoStory; stage?: string };

const PANELS: Record<DemoPortal, Record<string, (props: PanelProps) => ReactNode>> = {
  manager: {
    dashboard: ({ story }) => <DashboardPanel story={story} />,
    properties: ({ story }) => <PropertiesPanel story={story} />,
    tours: ({ story }) => <ToursPanel story={story} />,
    applications: ({ story }) => <ApplicationsPanel story={story} />,
    leases: ({ story }) => <LeasesPanel story={story} />,
    residents: ({ story }) => <ResidentsPanel story={story} />,
    payments: ({ story }) => <PaymentsPanel story={story} />,
    services: ({ story }) => <ServicesPanel story={story} />,
    calendar: ({ story }) => <CalendarPanel story={story} />,
    communication: () => <CommunicationPanel />,
    vendors: ({ story }) => <VendorsPanel story={story} />,
  },
  resident: {
    home: ({ story }) => <ResidentHomePanel story={story} />,
    applications: ({ story }) => <ResidentApplicationsPanel story={story} />,
    lease: ({ story }) => <ResidentLeasePanel story={story} />,
    payments: ({ story }) => <ResidentPaymentsPanel story={story} />,
    services: ({ story }) => <ResidentServicesPanel story={story} />,
    forms: ({ story }) => <ResidentFormsPanel story={story} />,
    communication: ({ story, stage }) => (
      <ResidentCommunicationPanel conversations={residentConversations(story, phoneScriptFor("resident", stage ?? "forms").items)} />
    ),
  },
  vendor: {
    services: ({ story }) => <VendorServicesPanel story={story} />,
    calendar: ({ story }) => <VendorCalendarPanel story={story} />,
    payments: ({ story }) => <VendorPaymentsPanel story={story} />,
    reviews: () => <VendorReviewsPanel />,
    communication: ({ stage }) => (
      <VendorCommunicationPanel conversations={vendorConversations(phoneScriptFor("vendor", stage ?? "visit").items)} />
    ),
  },
};

/** What a portal shows when the engine does not say where the story is: the manager's standing
 * portfolio, and the resident's and vendor's fullest view (so no tab is an empty frame). */
function defaultStory(portal: DemoPortal): DemoStory {
  return portal === "manager" ? NO_STORY : portal === "resident" ? residentStory(undefined) : vendorStory(undefined);
}

/** The portal screen for one tab, fed fixtures and the story's progress. An unknown tab falls
 * back to that portal's first, so the demo never renders an empty frame. `stage` is the
 * resident or vendor stage id, which decides what the phone beside the panel also says. */
export function DemoPanel({ portal, tab, story, stage }: { portal: DemoPortal; tab: string; story?: DemoStory; stage?: string }) {
  const panels = PANELS[portal];
  const render = panels[tab] ?? panels[DEMO_TABS[portal][0]!.id]!;
  return (
    <BarePanelChrome key={`${portal}:${tab}`}>
      {render({ story: story ?? defaultStory(portal), stage })}
    </BarePanelChrome>
  );
}
