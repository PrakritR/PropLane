"use client";

/**
 * The home page demo's contract with its panels: every portal tab the guided
 * demo can open, and one component that draws it. The demo engine owns the
 * window frame and the sidebar; `DemoPanel` renders only the portal screen
 * itself (inside `BarePanelChrome`, so the lifecycle rows' window chrome and
 * sidebar are left out), fed the shared fixtures. Nothing here saves, fetches
 * or navigates.
 *
 * The sidebar's tabs are NOT listed here: `DEMO_TABS` is derived from the real
 * portal nav (`demo-nav.ts`), so every real sidebar item has an entry below and
 * `tests/unit/home-demo-nav-parity.test.ts` fails when one does not.
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
import { DEMO_TABS, type DemoPortal, type DemoTab } from "@/components/marketing/site/product-mock/demo-nav";
import {
  ManagerDashboardView,
  ResidentDashboardView,
  VendorDashboardDemo,
} from "@/components/marketing/site/product-mock/dashboards";
import {
  ApplicationsPanel,
  CommunicationPanel,
  LeasesPanel,
  PaymentsPanel,
  ServicesPanel,
  ToursPanel,
} from "@/components/marketing/site/product-mock/panels";
import { CalendarPanel, PropertiesPanel, ResidentsPanel, VendorsPanel } from "@/components/marketing/site/product-mock/panels-manager-more";
import {
  BookingsPanel,
  DocumentsPanel,
  FinancesPanel,
  FormsPanel,
  OutgoingPaymentsPanel,
  PromotionPanel,
  TasksPanel,
} from "@/components/marketing/site/product-mock/panels-manager-rest";
import {
  ResidentApplicationsPanel,
  ResidentCommunicationPanel,
  ResidentFormsPanel,
  ResidentHomePanel,
  ResidentLeasePanel,
  ResidentPaymentsPanel,
  ResidentServicesPanel,
} from "@/components/marketing/site/product-mock/panels-resident";
import { ResidentDocumentsPanel, ResidentTourPanel } from "@/components/marketing/site/product-mock/panels-resident-more";
import {
  VendorCalendarPanel,
  VendorCommunicationPanel,
  VendorDocumentsPanel,
  VendorFinancesPanel,
  VendorPaymentsPanel,
  VendorReviewsPanel,
  VendorServicesPanel,
} from "@/components/marketing/site/product-mock/panels-vendor";

export { DEMO_TABS };
export type { DemoPortal, DemoTab, DemoStory };

type PanelProps = { story: DemoStory; stage?: string; sub?: string };

/** One entry per REAL sidebar section id (the key IS the section id: `move-in`, `work-orders`, ...). */
const PANELS: Record<DemoPortal, Record<string, (props: PanelProps) => ReactNode>> = {
  manager: {
    dashboard: ({ story }) => <ManagerDashboardView story={story} />,
    tasks: () => <TasksPanel />,
    calendar: ({ story }) => <CalendarPanel story={story} />,
    communication: () => <CommunicationPanel />,
    properties: ({ story }) => <PropertiesPanel story={story} />,
    bookings: () => <BookingsPanel />,
    promotion: () => <PromotionPanel />,
    tours: ({ story }) => <ToursPanel story={story} />,
    applications: ({ story }) => <ApplicationsPanel story={story} />,
    leases: ({ story }) => <LeasesPanel story={story} />,
    forms: ({ story }) => <FormsPanel story={story} />,
    residents: ({ story }) => <ResidentsPanel story={story} />,
    vendors: ({ story }) => <VendorsPanel story={story} />,
    services: ({ story }) => <ServicesPanel story={story} />,
    payments: ({ story }) => <PaymentsPanel story={story} />,
    outgoing: ({ story }) => <OutgoingPaymentsPanel story={story} />,
    financials: ({ story }) => <FinancesPanel story={story} />,
    documents: ({ story }) => <DocumentsPanel story={story} />,
  },
  resident: {
    dashboard: ({ story, stage }) => <ResidentDashboardView story={story} stage={stage} />,
    communication: ({ story, stage }) => (
      <ResidentCommunicationPanel conversations={residentConversations(story, phoneScriptFor("resident", stage ?? "forms").items)} />
    ),
    "move-in": ({ story }) => <ResidentHomePanel story={story} />,
    lease: ({ story }) => <ResidentLeasePanel story={story} />,
    forms: ({ story }) => <ResidentFormsPanel story={story} />,
    services: ({ story }) => <ResidentServicesPanel story={story} />,
    tour: ({ story }) => <ResidentTourPanel story={story} />,
    applications: ({ story }) => <ResidentApplicationsPanel story={story} />,
    payments: ({ story }) => <ResidentPaymentsPanel story={story} />,
    documents: ({ story }) => <ResidentDocumentsPanel story={story} />,
  },
  vendor: {
    dashboard: ({ story, stage }) => <VendorDashboardDemo story={story} stage={stage} />,
    communication: ({ stage }) => (
      <VendorCommunicationPanel conversations={vendorConversations(phoneScriptFor("vendor", stage ?? "visit").items)} />
    ),
    calendar: ({ story }) => <VendorCalendarPanel story={story} />,
    "work-orders": ({ story }) => <VendorServicesPanel story={story} />,
    reviews: () => <VendorReviewsPanel />,
    // The real Finances nests five sections; bare /vendor/financials lands on Balance & payouts, the sidebar sub-row opens Payments.
    financials: ({ story, sub }) => (sub === "income" ? <VendorPaymentsPanel story={story} /> : <VendorFinancesPanel story={story} />),
    documents: () => <VendorDocumentsPanel />,
  },
};

/** The section ids a portal has a panel for (the parity test reads this against the real nav). */
export function demoPanelIds(portal: DemoPortal): string[] {
  return Object.keys(PANELS[portal]);
}

/** What a portal shows when the engine does not say where the story is: the manager's standing
 * portfolio, and the resident's and vendor's fullest view (so no tab is an empty frame). */
function defaultStory(portal: DemoPortal): DemoStory {
  return portal === "manager" ? NO_STORY : portal === "resident" ? residentStory(undefined) : vendorStory(undefined);
}

/** The portal screen for one tab, fed fixtures and the story's progress. An unknown tab falls
 * back to that portal's first, so the demo never renders an empty frame. `stage` is the
 * resident or vendor stage id, which decides what the phone beside the panel also says. */
export function DemoPanel({ portal, tab, story, stage, sub }: { portal: DemoPortal; tab: string; story?: DemoStory; stage?: string; sub?: string }) {
  const panels = PANELS[portal];
  const render = panels[tab] ?? panels[DEMO_TABS[portal][0]!.id]!;
  return (
    <BarePanelChrome key={`${portal}:${tab}:${sub ?? ""}`}>
      {render({ story: story ?? defaultStory(portal), stage, sub })}
    </BarePanelChrome>
  );
}
