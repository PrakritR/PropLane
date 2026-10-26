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
import dynamic from "next/dynamic";
import { DemoSampleLoading } from "./demo-sample-loading";
import { BarePanelChrome, InertDemoLinks } from "@/components/marketing/site/product-mock/shared";
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
  VendorFinancesRouter,
  VendorPaymentsPanel,
  VendorReviewsPanel,
  VendorServicesPanel,
  VendorOutgoingPanel,
} from "@/components/marketing/site/product-mock/panels-vendor";

/**
 * The three role Dashboards are the real portal's own dashboard components, so
 * they drag the portal data stores in behind them. The public home page should
 * not carry that in its first-load JS: they load as their own chunk. SSR is
 * left on, so the markup the visitor first sees is unchanged and the demo still
 * looks exactly like the portal; the placeholder only ever shows while a later
 * tab's chunk arrives, and it holds the panel's own page box so nothing jumps.
 */
const dashboards = () => import("@/components/marketing/site/product-mock/dashboards");

const ManagerDashboardView = dynamic(() => dashboards().then((m) => m.ManagerDashboardView), {
  loading: DemoSampleLoading,
});
const ResidentDashboardView = dynamic(() => dashboards().then((m) => m.ResidentDashboardView), {
  loading: DemoSampleLoading,
});
const VendorDashboardDemo = dynamic(() => dashboards().then((m) => m.VendorDashboardDemo), {
  loading: DemoSampleLoading,
});

export { DEMO_TABS };
export type { DemoPortal, DemoTab, DemoStory };

type PanelProps = { story: DemoStory; stage?: string; sub?: string; onNavigate?: (section: string) => void };

/** One entry per REAL sidebar section id (the key IS the section id: `move-in`, `work-orders`, ...). */
const PANELS: Record<DemoPortal, Record<string, (props: PanelProps) => ReactNode>> = {
  manager: {
    dashboard: ({ story, onNavigate }) => <ManagerDashboardView story={story} onNavigate={onNavigate} scrollWithinWindow={!onNavigate} />,
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
    dashboard: ({ story, stage, onNavigate }) => <ResidentDashboardView story={story} stage={stage} onNavigate={onNavigate} />,
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
    dashboard: ({ story, stage, onNavigate }) => <VendorDashboardDemo story={story} stage={stage} onNavigate={onNavigate} />,
    communication: ({ stage }) => (
      <VendorCommunicationPanel conversations={vendorConversations(phoneScriptFor("vendor", stage ?? "visit").items)} />
    ),
    calendar: ({ story }) => <VendorCalendarPanel story={story} />,
    "work-orders": ({ story }) => <VendorServicesPanel story={story} />,
    // Tasks a manager assigned to the vendor; the demo draws the manager's task list shape.
    tasks: () => <TasksPanel />,
    reviews: () => <VendorReviewsPanel />,
    // The Money group: Incoming payments · Outgoing payments · Finances (vendor-portal-ia-1007).
    payments: ({ story }) => <VendorPaymentsPanel story={story} />,
    outgoing: () => <VendorOutgoingPanel />,
    // Finances nests Overview, Balance & payouts and Refunds; bare /vendor/financials lands on Overview.
    financials: ({ story, sub }) => <VendorFinancesRouter story={story} sub={sub} />,
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
export function DemoPanel({ portal, tab, story, stage, sub, onNavigate }: { portal: DemoPortal; tab: string; story?: DemoStory; stage?: string; sub?: string; onNavigate?: (section: string) => void }) {
  const panels = PANELS[portal];
  const render = panels[tab] ?? panels[DEMO_TABS[portal][0]!.id]!;
  return (
    <BarePanelChrome key={`${portal}:${tab}:${sub ?? ""}`}>
      <InertDemoLinks onNavigate={tab === "dashboard" ? undefined : onNavigate}>{render({ story: story ?? defaultStory(portal), stage, sub, onNavigate })}</InertDemoLinks>
    </BarePanelChrome>
  );
}
