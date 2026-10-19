"use client";

import type { ComponentType, ReactNode } from "react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { parseResidentDocumentTab } from "@/lib/resident-documents-tabs";
import { PortalDataTableEmpty } from "@/components/portal/portal-data-table";
import { ManagerFormsPage } from "@/components/portal/move-in-forms/forms-list";
import { ResidentMoveInShell } from "@/components/portal/resident-move-in-view";
import { readExtraListingsForUser } from "@/lib/demo-property-pipeline";
import { readManagerApplicationRows } from "@/lib/manager-applications-storage";
import {
  getDemoGuidedServerSnapshot,
  getDemoGuidedState,
  subscribeDemoGuidedState,
} from "@/lib/demo/demo-guided";
import type { DemoPortalRole } from "@/lib/demo/demo-session";
import {
  DEMO_GUIDED_EMAIL,
  DEMO_GUIDED_NAME,
  DEMO_MANAGER_EMAIL,
  DEMO_MANAGER_NAME,
  DEMO_MANAGER_USER_ID,
  DEMO_RESIDENT_EMAIL,
  DEMO_RESIDENT_NAME,
  DEMO_RESIDENT_USER_ID,
  DEMO_VENDOR_NAME,
  demoSessionForRole,
  getDemoRole,
  resolveDemoPortfolioScopeUserId,
  subscribeDemoRole,
} from "@/lib/demo/demo-session";
import type { ManagerLeaseTab } from "@/data/demo-portal";
import type { PortalSection } from "@/lib/portal-types";
import { parseResidentMoveInTab, parseApplicationListTab, parseResidentTourBucket, parseServiceDetailTab } from "@/lib/portal-detail-routes";
import { parseVendorWorkOrderTab } from "@/lib/vendor-work-order-tabs";
import { parseServiceStage } from "@/lib/service-stage-ids";
import { resolveResidentMoveInFromApplications } from "@/lib/resident-move-in-resolve";

const loading = () => (
  <div className="flex min-h-[40vh] items-center justify-center text-sm text-muted">Loading…</div>
);

/**
 * A code-split panel that, once its chunk has loaded, renders synchronously. `next/dynamic` suspends on every
 * first render per mount and the fallback then lingers (React throttles revealing the content), so a section the
 * homepage demo's cursor opens would flash "Loading…". The homepage embed preloads every panel before it starts
 * (`preloadHomeDemoPanels`), so after that no panel ever shows a loading state.
 */
function panel<P extends object>(loader: () => Promise<ComponentType<P>>): ComponentType<P> & { preload: () => Promise<unknown> } {
  let Resolved: ComponentType<P> | null = null;
  let pending: Promise<unknown> | null = null;
  const load = () => (pending ??= loader().then((component) => { Resolved = component; }));
  function Panel(props: P) {
    const [, rerender] = useState(0);
    useEffect(() => {
      if (!Resolved) void load().then(() => rerender((n) => n + 1));
    }, []);
    const Ready = Resolved;
    return Ready ? <Ready {...props} /> : loading();
  }
  Panel.preload = load;
  return Panel;
}
const preloaders: Array<() => Promise<unknown>> = [];
function demoPanel<P extends object>(loader: () => Promise<ComponentType<P>>): ComponentType<P> {
  const component = panel(loader);
  preloaders.push(component.preload);
  return component;
}

// Manager / pro panels
const ManagerDashboard = demoPanel(() => import("@/components/portal/pro-dashboard").then((m) => m.ManagerDashboard));
const ManagerProperties = demoPanel(() => import("@/components/portal/pro-properties").then((m) => m.ManagerProperties));
const ManagerTours = demoPanel(() => import("@/components/portal/pro-tours").then((m) => m.ManagerTours));
const ManagerApplications = demoPanel(() => import("@/components/portal/pro-applications").then((m) => m.ManagerApplications));
const ManagerResidents = demoPanel(() => import("@/components/portal/pro-residents").then((m) => m.ManagerResidents));
const ManagerLeases = demoPanel(() => import("@/components/portal/pro-leases").then((m) => m.ManagerLeases));
const ManagerPayments = demoPanel(() => import("@/components/portal/pro-payments").then((m) => m.ManagerPayments));
const ManagerTaskList = demoPanel(() => import("@/components/portal/pro-task-list").then((m) => m.ManagerTaskList));
// The SAME Communication wrapper the real portal's section map renders
// (src/lib/render-portal-section.tsx) — not the bare inbox panel above, which
// stayed a legacy path here (Unopened/Opened/Sent/Trash tabs the real portal
// retired). Keeps `/demo` from drifting into a second, hand-maintained
// Communication surface.
const ManagerCommunication = demoPanel(() => import("@/components/portal/pro-communication").then((m) => m.ManagerCommunication));
const DemoImportReviewPanel = demoPanel(() => import("@/components/demo/demo-import-review-panel").then((m) => m.DemoImportReviewPanel));
const ManagerAllServicesPanel = demoPanel(() => import("@/components/portal/pro-all-services-panel").then((m) => m.ManagerAllServicesPanel));
const ManagerFinancesPanel = demoPanel(() => import("@/components/portal/pro-finances-panel").then((m) => m.ManagerFinancesPanel));
const ManagerDocumentsPanel = demoPanel(() => import("@/components/portal/pro-documents-panel").then((m) => m.ManagerDocumentsPanel));
const PortalCalendar = demoPanel(() => import("@/components/portal/portal-calendar").then((m) => m.PortalCalendar));
const ManagerPromotion = demoPanel(() => import("@/components/portal/pro-promotion").then((m) => m.ManagerPromotion));
const ManagerMobileAppPanel = demoPanel(() => import("@/components/portal/pro-mobile-app-panel").then((m) => m.ManagerMobileAppPanel));
const PortalBugFeedbackPanel = demoPanel(() => import("@/components/portal/portal-bug-feedback-panel").then((m) => m.PortalBugFeedbackPanel));
const PortalProfileClient = demoPanel(() => import("@/components/portal/portal-profile-client").then((m) => m.PortalProfileClient));

// Resident panels
const ResidentDashboard = demoPanel(() => import("@/components/portal/resident-dashboard").then((m) => m.ResidentDashboard));
const ResidentApplicationsPanel = demoPanel<{ applyMode?: boolean }>(() => import("@/components/portal/resident-applications-panel").then((m) => m.ResidentApplicationsPanel));
const ResidentLeasePanel = demoPanel(() => import("@/components/portal/resident-lease-panel").then((m) => m.ResidentLeasePanel));
const ResidentPaymentsPanel = demoPanel(() => import("@/components/portal/resident-payments-panel").then((m) => m.ResidentPaymentsPanel));
const ResidentServicesPanel = demoPanel(() => import("@/components/portal/resident-services-panel").then((m) => m.ResidentServicesPanel));
// Same reasoning as ManagerCommunication above — the real resident section
// map renders this wrapper, never the bare panel.
const ResidentTourPanel = demoPanel(() => import("@/components/portal/resident-tour-panel").then((m) => m.ResidentTourPanel));
const ResidentCommunication = demoPanel(() => import("@/components/portal/resident-communication").then((m) => m.ResidentCommunication));
const ResidentDocumentsPanel = demoPanel(() => import("@/components/portal/resident-documents-panel").then((m) => m.ResidentDocumentsPanel));
const ResidentProfilePanel = demoPanel(() => import("@/components/portal/resident-profile-panel").then((m) => m.ResidentProfilePanel));

// Vendor panels
const VendorDashboard = demoPanel(() => import("@/components/portal/vendor-dashboard").then((m) => m.VendorDashboard));
const VendorWorkOrdersPanel = demoPanel(() => import("@/components/portal/vendor-work-orders-panel").then((m) => m.VendorWorkOrdersPanel));
const VendorCalendarPanel = demoPanel(() => import("@/components/portal/vendor-calendar-panel").then((m) => m.VendorCalendarPanel));
// Same reasoning as ManagerCommunication above — the real vendor section map
// renders this wrapper, never the bare panel.
const VendorCommunication = demoPanel(() => import("@/components/portal/vendor-communication").then((m) => m.VendorCommunication));
const VendorPaymentsPanel = demoPanel(() => import("@/components/portal/vendor-payments-panel").then((m) => m.VendorPaymentsPanel));
const VendorFinancesPanel = demoPanel(() => import("@/components/portal/vendor-finances-panel").then((m) => m.VendorFinancesPanel));
const VendorDocumentsPanel = demoPanel(() => import("@/components/portal/vendor-documents-panel").then((m) => m.VendorDocumentsPanel));
const VendorSettingsPanel = demoPanel(() => import("@/components/portal/vendor-settings-panel").then((m) => m.VendorSettingsPanel));

/**
 * Load every panel chunk, resolving once all are in (or after `timeoutMs`, so a slow chunk never holds the demo
 * back). Only the homepage embed calls this, before it starts the journey.
 */
export function preloadHomeDemoPanels(timeoutMs = 12_000): Promise<void> {
  const all = Promise.all(preloaders.map((load) => load().catch(() => undefined))).then(() => undefined);
  const timeout = new Promise<void>((resolve) => window.setTimeout(resolve, timeoutMs));
  return Promise.race([all, timeout]);
}

function Placeholder({ title, message }: { title: string; message: string }) {
  return (
    <ManagerPortalPageShell title={title}>
      <PortalDataTableEmpty message={message} icon="default" />
    </ManagerPortalPageShell>
  );
}

function useDemoSession(role: DemoPortalRole) {
  useSyncExternalStore(subscribeDemoGuidedState, getDemoGuidedState, getDemoGuidedServerSnapshot);
  const activeRole = useSyncExternalStore(subscribeDemoRole, getDemoRole, () => "manager" as const);
  return demoSessionForRole(activeRole ?? role);
}

export function DemoSectionRenderer({
  role,
  section,
  tab,
  path = [],
  meta,
}: {
  role: DemoPortalRole;
  section: string;
  tab: string | null;
  /** Everything after the section in the address (`work-orders/open/<id>`): a record opened in place. */
  path?: string[];
  meta: PortalSection | undefined;
}): ReactNode {
  const session = useDemoSession(role);
  const managerUserId = session.userId ?? DEMO_MANAGER_USER_ID;
  const managerDisplayName =
    session.email === DEMO_GUIDED_EMAIL ? DEMO_GUIDED_NAME : DEMO_MANAGER_NAME;
  const managerEmail = session.email ?? DEMO_MANAGER_EMAIL;

  const firstTab = meta?.tabs[0]?.id;
  const tabId = tab ?? firstTab ?? "index";
  const basePath = role === "resident" ? "/resident" : role === "vendor" ? "/vendor" : "/portal";

  if (role === "vendor") {
    switch (section) {
      case "dashboard":
        return <VendorDashboard displayName={DEMO_VENDOR_NAME} />;
      case "work-orders":
        // The tab rides in the address (`/vendor/work-orders/assigned`), as in the real route.
        return <VendorWorkOrdersPanel tabId={parseVendorWorkOrderTab(tab)} />;
      case "calendar":
        return <VendorCalendarPanel />;
      case "inbox":
      case "communication":
        return <VendorCommunication />;
      case "financials":
        return <VendorFinancesPanel tabId={tabId ?? "income"} basePath="/vendor" />;
      case "payments":
        return <VendorPaymentsPanel />;
      case "documents":
        return <VendorDocumentsPanel basePath="/vendor" demo />;
      case "profile":
        return <VendorSettingsPanel />;
      default:
        return <Placeholder title={meta?.label ?? "Section"} message="Nothing to show yet." />;
    }
  }

  if (role === "manager") {
    switch (section) {
      case "dashboard":
        return <ManagerDashboard displayName={managerDisplayName} />;
      case "properties":
        return <ManagerProperties />;
      case "tours":
        return (
          <ManagerTours
            bucket={tabId === "upcoming" || tabId === "past" ? tabId : "pending"}
            basePath={basePath}
          />
        );
      // Not a sidebar nav item (matches the real /portal/properties/import,
      // reached from a button on Properties, not its own nav entry) — a
      // deep-link-only section for the home page's "Switching" embed.
      case "import":
        return <DemoImportReviewPanel />;
      case "calendar":
        return <PortalCalendar portal="manager" initialUserId={managerUserId} />;
      case "applications":
        // The tab rides in the address (`/portal/applications/approved`), as in the real route.
        return <ManagerApplications bucket={parseApplicationListTab(tab)} basePath={basePath} />;
      // The demo never writes: the page renders its empty state (no forms are ever loaded
      // or sent while demo mode is on).
      case "forms":
        return <ManagerFormsPage tab={tabId} basePath={basePath} />;
      case "residents":
        return <ManagerResidents tabId="current" />;
      case "leases":
        return <ManagerLeases tab={(tab ?? "draft") as ManagerLeaseTab} basePath={basePath} />;
      case "payments":
        // The bucket rides in the address (`/portal/payments/paid`), as in the real route.
        return <ManagerPayments bucket={tab === "paid" || tab === "overdue" ? tab : "pending"} basePath={basePath} />;
      case "task-list":
        return <ManagerTaskList tabId={tabId === "completed" ? "completed" : "open"} basePath={basePath} />;
      case "services": {
        // `/portal/services/work-orders/<bucket>/<id>[/<tab>]` opens that service's own record, as the real route does.
        const [kind, bucket, recordId, recordTab] = path;
        const isRecord = Boolean(recordId) && (kind === "work-orders" || kind === "requests");
        return (
          <ManagerAllServicesPanel
            tabId={tabId === "work-orders" ? "work-orders" : "requests"}
            basePath={basePath}
            {...(isRecord && kind === "work-orders"
              ? { workOrderBucket: parseServiceStage(bucket), workOrderId: decodeURIComponent(recordId!) }
              : {})}
            {...(isRecord && kind === "requests" ? { serviceRequestId: decodeURIComponent(recordId!) } : {})}
            {...(isRecord && recordTab ? { serviceDetailTab: parseServiceDetailTab(recordTab) } : {})}
          />
        );
      }
      case "inbox":
      case "communication":
        return <ManagerCommunication />;
      case "financials":
        return <ManagerFinancesPanel tabId={tabId} basePath={basePath} />;
      case "documents":
        return <ManagerDocumentsPanel tabId={tabId} basePath={basePath} />;
      case "teams":
      case "relationships":
        // Demo mirrors production: team lives under Settings → Workspaces.
        return (
          <PortalProfileClient
            variant="manager"
            portalKind="pro"
            initialFullName={managerDisplayName}
            initialEmail={managerEmail}
            initialPhone="(206) 555-0101"
            idLabel="PropLane ID"
            idValue="PROPLANE-DEMO4821"
          />
        );
      case "promotion":
        return <ManagerPromotion />;
      case "bugs-feedback":
        // The demo manager portal mirrors the real "pro" portal definition.
        return <PortalBugFeedbackPanel reporterRole="pro" />;
      case "app":
        return <ManagerMobileAppPanel />;
      case "profile":
        return (
          <PortalProfileClient
            variant="manager"
            portalKind="pro"
            initialFullName={managerDisplayName}
            initialEmail={managerEmail}
            initialPhone="(206) 555-0101"
            idLabel="PropLane ID"
            idValue="PROPLANE-DEMO4821"
          />
        );
      default:
        return <Placeholder title={meta?.label ?? "Section"} message="Nothing to show yet." />;
    }
  }

  // resident
  switch (section) {
    case "dashboard":
      return (
        <ResidentDashboard
          applicationApproved={false}
          displayName={DEMO_RESIDENT_NAME}
          residentEmail={DEMO_RESIDENT_EMAIL}
          residentUserId={DEMO_RESIDENT_USER_ID}
          managerSubscriptionTier="paid"
        />
      );
    case "tour": {
      // The real /resident/tour route: `/tour/<bucket>` is the list, `/tour/<bucket>/<id>` one tour's own page.
      const bucket = parseResidentTourBucket(tab);
      const inquiryId = path[0] ? decodeURIComponent(path[0]) : undefined;
      return <ResidentTourPanel bucket={bucket} basePath={basePath} {...(inquiryId ? { inquiryId } : {})} />;
    }
    case "applications":
      // Same live-data component as the real portal: usePortalSession() and
      // readManagerApplicationRows() are both demo-aware, so it renders the
      // seeded demoApplications() rows with no adapter needed (mirrors how
      // the manager switch above reuses ManagerApplications directly).
      return <ResidentApplicationsPanel applyMode={tab === "apply"} />;
    case "lease":
      // ResidentLeasePanel renders its own "Lease" page shell; wrapping it in a
      // second shell would stack the header twice. `?tab=<leaseId>` deep-links
      // straight to that lease's own detail/sign view (the real route's
      // `leaseDetailId`) — otherwise the bare list only shows already-signed
      // document snapshots, which a lease still awaiting a signature has none
      // of yet.
      // `/lease` opens on the first tab with a lease, `/lease/<pending|signed>` is that list, anything else a lease id.
      if (tab === "pending" || tab === "signed") return <ResidentLeasePanel basePath={basePath} bucket={tab} />;
      return <ResidentLeasePanel basePath={basePath} {...(tab ? { leaseDetailId: tab } : { bucketNamed: false })} />;
    case "payments":
      // Payments is Charges-only now — no sub-tabs to forward.
      return <ResidentPaymentsPanel bucket={tab === "paid" || tab === "overdue" ? tab : "pending"} basePath={basePath} />;
    case "move-in":
      return <ResidentMoveInDemo tabId={tabId} basePath={basePath} />;
    case "services":
      return <ResidentServicesPanel basePath={basePath} />;
    case "inbox":
    case "communication":
      return <ResidentCommunication residentUserId={DEMO_RESIDENT_USER_ID} />;
    case "documents":
      // `tabId` here already comes from the same section metadata
      // (`resident-sections.ts`'s `DOCUMENTS_TABS`, now bucket ids), so
      // `parseResidentDocumentTab` maps it straight through.
      return <ResidentDocumentsPanel tabId={tabId} basePath={basePath} bucket={parseResidentDocumentTab(tabId)} />;
    case "bugs-feedback":
      return <ResidentProfilePanel />;
    case "profile":
      return <ResidentProfilePanel />;
    default:
      return <Placeholder title={meta?.label ?? "Section"} message="Nothing to show yet." />;
  }
}

/**
 * Same House details tab as the real resident portal: the shared presentational
 * view fed by the shared resolver, over the browser-local demo data
 * (the real portal resolves the identical shape server-side).
 */
function ResidentMoveInDemo({
  tabId,
  basePath,
}: {
  tabId: string;
  basePath: string;
}) {
  const resolved = useMemo(() => {
    const propertiesById = Object.fromEntries(
      readExtraListingsForUser(resolveDemoPortfolioScopeUserId()).map((p) => [p.id, p]),
    );
    return resolveResidentMoveInFromApplications(
      DEMO_RESIDENT_EMAIL,
      readManagerApplicationRows(),
      propertiesById,
    );
  }, []);

  const activeTab = parseResidentMoveInTab(tabId);

  return (
    <ManagerPortalPageShell title="House details" hideTitleOnMobileNav compactFilterRow>
      {resolved ? (
        <ResidentMoveInShell
          basePath={basePath}
          resolved={resolved}
          email={DEMO_RESIDENT_EMAIL}
          activeTab={activeTab}
        />
      ) : (
        <PortalDataTableEmpty message="House details appear here once a placement is assigned." icon="default" />
      )}
    </ManagerPortalPageShell>
  );
}
