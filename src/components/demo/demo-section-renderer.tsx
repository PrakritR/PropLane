"use client";

import dynamic from "next/dynamic";
import type { ReactNode } from "react";
import { useMemo, useSyncExternalStore } from "react";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalDataTableEmpty } from "@/components/portal/portal-data-table";
import { ManagerInspectionsPage } from "@/components/portal/inspections-panel";
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
import type { PortalSection } from "@/lib/portal-types";
import { parseResidentMoveInTab } from "@/lib/portal-detail-routes";
import { resolveResidentMoveInFromApplications } from "@/lib/resident-move-in-resolve";

const loading = () => (
  <div className="flex min-h-[40vh] items-center justify-center text-sm text-muted">Loading…</div>
);

// Manager / pro panels
const ManagerDashboard = dynamic(() => import("@/components/portal/pro-dashboard").then((m) => m.ManagerDashboard), { ssr: false, loading });
const ManagerProperties = dynamic(() => import("@/components/portal/pro-properties").then((m) => m.ManagerProperties), { ssr: false, loading });
const ManagerApplications = dynamic(() => import("@/components/portal/pro-applications").then((m) => m.ManagerApplications), { ssr: false, loading });
const ManagerResidents = dynamic(() => import("@/components/portal/pro-residents").then((m) => m.ManagerResidents), { ssr: false, loading });
const ManagerLeases = dynamic(() => import("@/components/portal/pro-leases").then((m) => m.ManagerLeases), { ssr: false, loading });
const ManagerPayments = dynamic(() => import("@/components/portal/pro-payments").then((m) => m.ManagerPayments), { ssr: false, loading });
const ManagerTaskList = dynamic(() => import("@/components/portal/pro-task-list").then((m) => m.ManagerTaskList), { ssr: false, loading });
const ManagerInbox = dynamic(() => import("@/components/portal/pro-inbox").then((m) => m.ManagerInbox), { ssr: false, loading });
const ManagerAllServicesPanel = dynamic(() => import("@/components/portal/pro-all-services-panel").then((m) => m.ManagerAllServicesPanel), { ssr: false, loading });
const ManagerFinancesPanel = dynamic(() => import("@/components/portal/pro-finances-panel").then((m) => m.ManagerFinancesPanel), { ssr: false, loading });
const ManagerDocumentsPanel = dynamic(() => import("@/components/portal/pro-documents-panel").then((m) => m.ManagerDocumentsPanel), { ssr: false, loading });
const PortalCalendar = dynamic(() => import("@/components/portal/portal-calendar").then((m) => m.PortalCalendar), { ssr: false, loading });
const ProAccountLinksPanel = dynamic(() => import("@/components/portal/pro-account-links-panel").then((m) => m.ProAccountLinksPanel), { ssr: false, loading });
const ManagerPromotion = dynamic(() => import("@/components/portal/pro-promotion").then((m) => m.ManagerPromotion), { ssr: false, loading });
const ManagerMobileAppPanel = dynamic(
  () => import("@/components/portal/pro-mobile-app-panel").then((m) => m.ManagerMobileAppPanel),
  { ssr: false, loading },
);
const PortalBugFeedbackPanel = dynamic(() => import("@/components/portal/portal-bug-feedback-panel").then((m) => m.PortalBugFeedbackPanel), { ssr: false, loading });
const PortalProfileClient = dynamic(() => import("@/components/portal/portal-profile-client").then((m) => m.PortalProfileClient), { ssr: false, loading });

// Resident panels
const ResidentDashboard = dynamic(() => import("@/components/portal/resident-dashboard").then((m) => m.ResidentDashboard), { ssr: false, loading });
const ResidentApplicationsPanel = dynamic(() => import("@/components/portal/resident-applications-panel").then((m) => m.ResidentApplicationsPanel), { ssr: false, loading });
const ResidentLeasePanel = dynamic(() => import("@/components/portal/resident-lease-panel").then((m) => m.ResidentLeasePanel), { ssr: false, loading });
const ResidentPaymentsPanel = dynamic(() => import("@/components/portal/resident-payments-panel").then((m) => m.ResidentPaymentsPanel), { ssr: false, loading });
const ResidentServicesPanel = dynamic(() => import("@/components/portal/resident-services-panel").then((m) => m.ResidentServicesPanel), { ssr: false, loading });
const ResidentInboxPanel = dynamic(() => import("@/components/portal/resident-inbox-panel").then((m) => m.ResidentInboxPanel), { ssr: false, loading });
const ResidentDocumentsPanel = dynamic(() => import("@/components/portal/resident-documents-panel").then((m) => m.ResidentDocumentsPanel), { ssr: false, loading });
const ResidentProfilePanel = dynamic(() => import("@/components/portal/resident-profile-panel").then((m) => m.ResidentProfilePanel), { ssr: false, loading });

// Vendor panels
const VendorDashboard = dynamic(() => import("@/components/portal/vendor-dashboard").then((m) => m.VendorDashboard), { ssr: false, loading });
const VendorWorkOrdersPanel = dynamic(() => import("@/components/portal/vendor-work-orders-panel").then((m) => m.VendorWorkOrdersPanel), { ssr: false, loading });
const VendorCalendarPanel = dynamic(() => import("@/components/portal/vendor-calendar-panel").then((m) => m.VendorCalendarPanel), { ssr: false, loading });
const VendorInboxPanel = dynamic(() => import("@/components/portal/vendor-inbox-panel").then((m) => m.VendorInboxPanel), { ssr: false, loading });
const VendorPaymentsPanel = dynamic(() => import("@/components/portal/vendor-payments-panel").then((m) => m.VendorPaymentsPanel), { ssr: false, loading });
const VendorFinancesPanel = dynamic(() => import("@/components/portal/vendor-finances-panel").then((m) => m.VendorFinancesPanel), { ssr: false, loading });
const VendorDocumentsPanel = dynamic(() => import("@/components/portal/vendor-documents-panel").then((m) => m.VendorDocumentsPanel), { ssr: false, loading });
const VendorSettingsPanel = dynamic(() => import("@/components/portal/vendor-settings-panel").then((m) => m.VendorSettingsPanel), { ssr: false, loading });

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
  meta,
}: {
  role: DemoPortalRole;
  section: string;
  tab: string | null;
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
        return <VendorWorkOrdersPanel />;
      case "calendar":
        return <VendorCalendarPanel />;
      case "inbox":
      case "communication":
        return <VendorInboxPanel tabId={tabId} />;
      case "financials":
        return <VendorFinancesPanel tabId={tabId ?? "income"} basePath="/vendor" />;
      case "payments":
        return <VendorPaymentsPanel />;
      case "documents":
        return <VendorDocumentsPanel tabId={tabId ?? "tax"} basePath="/vendor" demo />;
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
      case "calendar":
        return <PortalCalendar portal="manager" initialUserId={managerUserId} />;
      case "applications":
        return <ManagerApplications />;
      case "inspections":
        return <ManagerInspectionsPage kind={tabId === "move-out" ? "move-out" : "move-in"} basePath={basePath} />;
      case "residents":
        return <ManagerResidents tabId="current" />;
      case "leases":
        return <ManagerLeases />;
      case "payments":
        return <ManagerPayments />;
      case "task-list":
        return <ManagerTaskList tabId={tabId === "completed" ? "completed" : "in-progress"} basePath={basePath} />;
      case "services":
        return (
          <ManagerAllServicesPanel
            tabId={tabId === "work-orders" ? "work-orders" : "requests"}
            basePath={basePath}
          />
        );
      case "inbox":
      case "communication":
        return <ManagerInbox tabId={tabId} />;
      case "financials":
        return <ManagerFinancesPanel tabId={tabId} basePath={basePath} />;
      case "documents":
        return <ManagerDocumentsPanel tabId={tabId} basePath={basePath} />;
      case "teams":
        if (tabId === "vendors") {
          return (
            <Placeholder
              title="Vendors"
              message="Vendor management is not available in the demo sandbox."
            />
          );
        }
        return <ProAccountLinksPanel userId={managerUserId} />;
      case "relationships":
        return <ProAccountLinksPanel userId={managerUserId} />;
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
    case "applications":
      // Same live-data component as the real portal: usePortalSession() and
      // readManagerApplicationRows() are both demo-aware, so it renders the
      // seeded demoApplications() rows with no adapter needed (mirrors how
      // the manager switch above reuses ManagerApplications directly).
      return <ResidentApplicationsPanel applyMode={tab === "apply"} />;
    case "lease":
      // ResidentLeasePanel renders its own "Lease" page shell; wrapping it in a
      // second shell would stack the header twice.
      return <ResidentLeasePanel />;
    case "payments":
      // Payments is Charges-only now — no sub-tabs to forward.
      return <ResidentPaymentsPanel />;
    case "move-in":
      return <ResidentMoveInDemo tabId={tabId} basePath={basePath} />;
    case "services":
      return <ResidentServicesPanel basePath={basePath} />;
    case "inbox":
    case "communication":
      return <ResidentInboxPanel tabId={tabId} />;
    case "documents":
      return <ResidentDocumentsPanel tabId={tabId} basePath={basePath} tabs={meta?.tabs ?? []} />;
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
