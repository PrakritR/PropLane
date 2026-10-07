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

/**
 * The sidebar's rows per portal, bucketed like the real shell (`PORTAL_NAV_GROUPS`,
 * `src/lib/portals/nav-groups.ts`): an unheaded home group, then short collapsible groups.
 * Labels are the real nav labels (`proPortal`, `residentPortal`, `vendorPortal`). The first
 * entry of each portal is the fallback panel, so it never moves.
 */
export const DEMO_TABS: Record<DemoPortal, DemoTab[]> = {
  manager: [
    { id: "dashboard", label: "Dashboard" },
    { id: "calendar", label: "Calendar" },
    { id: "communication", label: "Communication" },
    { id: "properties", label: "Properties", group: "Portfolio" },
    { id: "tours", label: "Tours", group: "Leasing" },
    { id: "applications", label: "Application", group: "Leasing" },
    { id: "leases", label: "Leases", group: "Leasing" },
    { id: "residents", label: "Residents", group: "People" },
    { id: "vendors", label: "Vendors", group: "People" },
    { id: "services", label: "Services", group: "People" },
    { id: "payments", label: "Incoming payments", group: "Money" },
  ],
  resident: [
    { id: "home", label: "My home", group: "My home" },
    { id: "lease", label: "Lease", group: "My home" },
    { id: "forms", label: "Forms", group: "My home" },
    { id: "services", label: "Services", group: "My home" },
    { id: "applications", label: "Applications", group: "Applying" },
    { id: "payments", label: "Payments", group: "Money" },
    { id: "communication", label: "Communication" },
  ],
  vendor: [
    { id: "services", label: "Services", group: "Work" },
    { id: "reviews", label: "Reviews", group: "Work" },
    { id: "calendar", label: "Calendar" },
    { id: "communication", label: "Communication" },
    { id: "payments", label: "Finances", group: "Money" },
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
