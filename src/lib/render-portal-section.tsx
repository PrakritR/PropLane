import { ManagerInspectionsPage, ResidentInspectionsPage } from "@/components/portal/inspections-panel";
import { isSmsCommUiEnabled } from "@/lib/sms-comm-ui-flag.server";
import { AdminDashboard } from "@/components/portal/admin-dashboard";
import { ManagerDashboard } from "@/components/portal/pro-dashboard";
import { ManagerLeases } from "@/components/portal/pro-leases";
import { ManagerPayments } from "@/components/portal/pro-payments";
import { ManagerPromotion } from "@/components/portal/pro-promotion";
import { ManagerMobileAppPanel } from "@/components/portal/pro-mobile-app-panel";
import { ManagerProfile } from "@/components/portal/pro-profile";
import { AdminCreateManagerClient } from "@/components/portal/admin-create-manager-client";
import { AdminCreateResidentClient } from "@/components/portal/admin-create-resident-client";
import { AdminAxisUsersClient } from "@/components/portal/admin-axis-users-client";
import { AdminBillingClient } from "@/components/portal/admin-billing-client";
import { AdminTestWorkspacesClient } from "@/components/portal/admin-test-workspaces-client";
import { AdminPropertiesClient } from "@/components/portal/admin-properties-client";
import { AdminEventsClient } from "@/components/portal/admin-events-client";
import { AdminProfileSection } from "@/components/portal/admin-profile-section";
import { AdminCommunication } from "@/components/portal/admin-communication";
import { AdminBugFeedbackClient } from "@/components/portal/admin-bug-feedback-client";
import { ResidentDashboard } from "@/components/portal/resident-dashboard";
import { ResidentMoveInPanel } from "@/components/portal/resident-move-in-panel";
import { ResidentMoveInShell } from "@/components/portal/resident-move-in-view";
import { ResidentCommunication } from "@/components/portal/resident-communication";
import { VendorCommunication } from "@/components/portal/vendor-communication";
import { ResidentPaymentsPanel } from "@/components/portal/resident-payments-panel";
import { ResidentDocumentsPanel } from "@/components/portal/resident-documents-panel";
import { ResidentApplicationsPanel } from "@/components/portal/resident-applications-panel";
import { ResidentTourPanel } from "@/components/portal/resident-tour-panel";
import { ResidentLeasePanel } from "@/components/portal/resident-lease-panel";
import { ResidentProfileSection } from "@/components/portal/resident-profile-section";
import { PortalBugFeedbackPanel } from "@/components/portal/portal-bug-feedback-panel";
import { VendorDashboard } from "@/components/portal/vendor-dashboard";
import { VendorWorkOrdersPanel } from "@/components/portal/vendor-work-orders-panel";
import { VendorFinancesPanel } from "@/components/portal/vendor-finances-panel";
import { VendorDocumentsPanel } from "@/components/portal/vendor-documents-panel";
import { VendorSettingsPanel } from "@/components/portal/vendor-settings-panel";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalTierPaywall, ResidentTierPaywall } from "@/components/portal/portal-tier-paywall";
import { PortalWorkspaceClient } from "@/components/portal/portal-workspace-client";
import { resolveSettingsRedirectHubTab } from "@/lib/portal-settings-section";
import {
  loadManagerAllServicesPanel,
  loadManagerTaskList,
  loadManagerTours,
  loadManagerBookings,
  loadManagerApplications,
  loadManagerDocumentsPanel,
  loadManagerFinancesPanel,
  loadManagerCommunication,
  loadManagerProperties,
  loadManagerResidents,
  loadManagerVendorsPanel,
  loadPortalCalendar,
  loadProAccountLinksPanel,
  loadResidentServicesPanel,
} from "@/lib/portal-panel-imports";
import type { Crumb } from "@/components/layout/breadcrumbs";
import type { TabItem } from "@/components/ui/tabs";
import type { ReactNode } from "react";
import { getEffectiveSessionForPortal, getEffectiveUserIdForPortal } from "@/lib/auth/effective-session";
import { getServerSessionProfile } from "@/lib/auth/server-profile";
import { managerSectionAllowedForTier, residentSectionAllowedForManagerTier } from "@/lib/manager-access";
import { getManagerPortalNavSubscriptionTier, getManagerSubscriptionTierByManagerId } from "@/lib/manager-access-server";
import { loadResidentPortalAccessState, residentPortalHomePath } from "@/lib/resident-portal-access";
import { isResidentPathAllowedForAccess } from "@/lib/resident-portal-nav";
import { findSection, getPortalDefinition } from "@/lib/portals";
import { MANAGER_PLAN_PORTAL_URL } from "@/lib/portals/manager-plan-path";
import { RESIDENT_PAYMENTS_LEGACY_TABS } from "@/lib/portals/resident-sections";
import { getProPortalRenderContext } from "@/lib/portals/pro-nav";
import { buildPortalWorkspaceModel } from "@/lib/portal-workspace-model";
import { legacyManagerPortalSectionPath, parseApplicationDetailTab, parseResidentMoveInTab } from "@/lib/portal-detail-routes";
import type { PortalKind } from "@/lib/portal-types";
import { notFound, redirect } from "next/navigation";
import { DEFERRED_SECTIONS } from "@/lib/portals/nav-locks";
import {
  isTestWorkspaceFeatureEnabled,
  requireTrustedTestWorkspaceOperator,
} from "@/lib/test-workspaces/index.server";

const LEGACY_FINANCIALS_TAB_MAP: Record<string, string> = {
  "rent-roll": "income",
  // Delinquency (overdue rent) lives inside the rent-roll/income view; the old
  // `summary` target is not a financials tab, so it used to 404.
  delinquency: "income",
  "income-statement": "expenses",
  vendors: "expenses",
  "profit-loss": "expenses",
  "cash-flow": "cash-flow-statement",
};

const DOCUMENTS_TABS = ["applications", "leases", "other", "library", "templates", "income-documents", "expense-documents", "occupancy", "1099", "tax-summary"] as const;

const LEGACY_DOCUMENTS_TAB_MAP: Record<string, string> = {
  summary: "tax-summary",
  "rent-receipts": "income-documents",
  "rental-days": "income-documents",
  library: "other",
};
const FINANCIALS_TABS = ["overview", "reports", "income", "expenses", "trial-balance", "balance-sheet", "general-ledger", "cash-flow-statement", "payout-history", "trust-account-balance", "security-deposits", "financial-diagnostics", "ap-aging", "bills", "budget-vs-actual", "bank-reconciliation", "owner-statement", "owner-distributions"] as const;

const MANAGER_INBOX_TABS = ["unopened", "opened", "schedule", "sent", "trash"] as const;

function isManagerInboxTab(tab: string): tab is (typeof MANAGER_INBOX_TABS)[number] {
  return (MANAGER_INBOX_TABS as readonly string[]).includes(tab);
}

const LEGACY_DOCUMENTS_TO_FINANCIALS: Record<string, string> = {
  expenses: "expenses",
  "profit-loss": "expenses",
};

// Legacy financials tabs whose current home is a DOCUMENTS tab, not a financials
// tab. `lease-expiration` used to map to `income-documents` inside the financials
// handler, which only redirects within /financials/, so it 404'd — it must cross
// into the documents section where `income-documents` actually lives.
const LEGACY_FINANCIALS_TO_DOCUMENTS: Record<string, string> = {
  "lease-expiration": "income-documents",
};

function legacyTabMapLookup<T extends string>(map: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

async function renderManagerFinancesSection(
  section: string,
  tabParts: string[] | undefined,
  basePath: string,
  kind: PortalKind,
  tier: "free" | "paid" | null,
) {
  if (section !== "financials") return null;
  if (!tabParts?.length) {
    redirect(`${basePath}/financials/overview`);
  }
  if (tabParts.length > 1) {
    if (tabParts.length === 2 && tabParts[1] === "pending") {
      redirect(`${basePath}/financials/${tabParts[0]}`);
    }
    notFound();
  }
  const finTab = tabParts[0]!;
  if (!FINANCIALS_TABS.includes(finTab as (typeof FINANCIALS_TABS)[number])) {
    const docsRedirect = legacyTabMapLookup(LEGACY_FINANCIALS_TO_DOCUMENTS, finTab);
    if (docsRedirect) redirect(`${basePath}/documents/${docsRedirect}`);
    const mapped = legacyTabMapLookup(LEGACY_FINANCIALS_TAB_MAP, finTab);
    if (mapped) redirect(`${basePath}/financials/${mapped}`);
    notFound();
  }
  const ManagerFinancesPanel = await loadManagerFinancesPanel();
  return subscriptionGated(
    <ManagerFinancesPanel tabId={finTab} basePath={basePath} />,
    kind,
    "financials",
    tier,
  );
}

async function renderManagerDocumentsSection(
  section: string,
  tabParts: string[] | undefined,
  basePath: string,
  kind: PortalKind,
  tier: "free" | "paid" | null,
) {
  if (section !== "documents") return null;
  if (!tabParts?.length) {
    redirect(`${basePath}/documents/applications`);
  }
  if (tabParts.length > 2) notFound();
  const docTab = tabParts[0]!;
  const legacyDocTab = legacyTabMapLookup(LEGACY_DOCUMENTS_TAB_MAP, docTab);
  if (legacyDocTab) redirect(`${basePath}/documents/${legacyDocTab}`);
  const financesRedirect = legacyTabMapLookup(LEGACY_DOCUMENTS_TO_FINANCIALS, docTab);
  if (financesRedirect) {
    redirect(`${basePath}/financials/${financesRedirect}`);
  }
  if (!DOCUMENTS_TABS.includes(docTab as (typeof DOCUMENTS_TABS)[number])) {
    // Not a known documents tab — a manager document RECORD id
    // (PLAN-0920-1058, area 1c): /documents/<id>/<tab>.
    const { parseDocumentDetailTab } = await import("@/lib/portal-detail-routes");
    const documentId = decodeURIComponent(docTab);
    const detailTabRaw = tabParts.length === 2 ? tabParts[1]! : undefined;
    const detailTab = parseDocumentDetailTab(detailTabRaw);
    if (detailTabRaw && detailTab !== detailTabRaw) {
      redirect(`${basePath}/documents/${encodeURIComponent(documentId)}/${detailTab}`);
    }
    const ManagerDocumentsPanel = await loadManagerDocumentsPanel();
    return subscriptionGated(
      <ManagerDocumentsPanel
        tabId="library"
        basePath={basePath}
        documentId={documentId}
        documentDetailTab={detailTab}
      />,
      kind,
      "documents",
      tier,
    );
  }
  if (tabParts.length === 2 && docTab !== "applications") {
    if (tabParts[1] === "pending") {
      redirect(`${basePath}/documents/${docTab}`);
    }
    notFound();
  }
  const applicationId =
    docTab === "applications" && tabParts.length === 2
      ? decodeURIComponent(tabParts[1]!)
      : undefined;
  const ManagerDocumentsPanel = await loadManagerDocumentsPanel();
  return subscriptionGated(
    <ManagerDocumentsPanel tabId={docTab} basePath={basePath} applicationId={applicationId} />,
    kind,
    "documents",
    tier,
  );
}

function subscriptionGated(
  node: ReactNode,
  kind: PortalKind,
  section: string,
  tier: "free" | "paid" | null,
  featureLabel?: string,
  basePath = "/portal",
): ReactNode {
  if (kind !== "manager" && kind !== "pro") return node;
  if (managerSectionAllowedForTier(section, tier)) return node;
  return <PortalTierPaywall basePath={basePath} featureLabel={featureLabel} />;
}

function managerTierPaywall(
  kind: PortalKind,
  section: string,
  tier: "free" | "paid" | null,
  featureLabel: string,
  basePath: string,
): ReactNode | null {
  if (kind !== "manager" && kind !== "pro") return null;
  if (tier !== "free") return null;
  if (managerSectionAllowedForTier(section, tier)) return null;
  return <PortalTierPaywall basePath={basePath} featureLabel={featureLabel} />;
}

function residentManagerTierGate(
  section: string,
  managerTier: "free" | "paid" | null,
  featureLabel: string,
): ReactNode | null {
  if (residentSectionAllowedForManagerTier(section, managerTier)) return null;
  return <ResidentTierPaywall featureLabel={featureLabel} />;
}

export type PortalSearchParams = Record<string, string | string[] | undefined>;

function firstSearchParam(searchParams: PortalSearchParams | undefined, key: string): string | null {
  const value = searchParams?.[key];
  if (typeof value === "string" && value) return value;
  if (Array.isArray(value) && value[0]) return value[0] ?? null;
  return null;
}

/** Re-serializes the incoming query string so a legacy redirect doesn't drop it. */
function searchSuffix(searchParams?: PortalSearchParams, extra?: Record<string, string>): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams ?? {})) {
    if (typeof value === "string") q.set(key, value);
    else if (Array.isArray(value)) value.forEach((entry) => q.append(key, entry));
  }
  for (const [key, value] of Object.entries(extra ?? {})) q.set(key, value);
  const qs = q.toString();
  return qs ? `?${qs}` : "";
}

export async function renderPortalSection(
  kind: PortalKind,
  section: string,
  tabParts?: string[],
  searchParams?: PortalSearchParams,
) {
  const def = await getPortalDefinition(kind);

  // A deferred section is unreachable by URL as well as by nav. The nav lock alone only hides the
  // door: typing `/portal/payments`, following an old bookmark, or an emailed link still rendered
  // the half-built surface the lock exists to keep people out of. AGENTS.md is explicit that a
  // locked row must never point at a path the server still serves — this is the server half of
  // that rule.
  //
  // Runs FIRST, before the legacy rewrites and the resident stage guard, so no earlier redirect
  // can land inside a deferred section (`stripe` -> `payments` did exactly that).
  if (DEFERRED_SECTIONS.has(section)) {
    redirect(`${def.basePath}/dashboard`);
  }

  if (section === "finances") {
    const defaultTab = kind === "resident" ? "summary" : "income";
    const tab = tabParts?.[0] ?? defaultTab;
    redirect(`${def.basePath}/financials/${tab}`);
  }

  if (kind === "admin" && (section === "managers" || section === "owners")) {
    redirect(`${def.basePath}/axis-users`);
  }

  if ((kind === "manager" || kind === "pro") && section === "upgrade") {
    redirect(MANAGER_PLAN_PORTAL_URL);
  }

  if ((kind === "manager" || kind === "pro") && section === "plan") {
    redirect(MANAGER_PLAN_PORTAL_URL);
  }

  if (kind === "manager" || kind === "pro") {
    if (section === "stripe") redirect(`${def.basePath}/payments`);
  }

  // ---------------------------------------------------------------------------
  // Legacy section redirects run BEFORE the resident stage guard below.
  //
  // The guard asks `isResidentPathAllowedForAccess` about the INCOMING path, and
  // none of these legacy ids (`inbox`, `financials`, `bugs-feedback`) is a real
  // resident section, so the guard answers "not allowed" and bounces every one
  // of them to the resident home page. Ordering is the whole fix: a legacy alias
  // must resolve to its live destination first, and the guard then judges THAT
  // path. Regression coverage: tests/unit/resident-legacy-section-redirects.test.ts.
  // ---------------------------------------------------------------------------

  // Legacy path support: Inbox became Communication. Old deep links (push
  // notifications, bookmarks, post-send navigation) must keep resolving.
  // Gated on the capability, not a kind allowlist: ungated, this would send a
  // portal that still ships Inbox as a real section to a Communication section
  // it does not have (notFound). Every portal has Communication today — the
  // gate is what keeps that from breaking silently if one stops having it.
  if (section === "inbox" && findSection(def, "communication")) {
    const legacySuffix = tabParts?.length ? tabParts.join("/") : "unopened";
    if (kind === "manager" || kind === "pro") {
      redirect(`${def.basePath}/communication/inbox/${legacySuffix}`);
    }
    redirect(`${def.basePath}/communication/email/${legacySuffix}`);
  }

  // Legacy path support: the resident "financials" section was merged into
  // Payments tabs. Must run BEFORE findSection — "financials" is not a resident
  // nav section, so findSection would notFound first.
  if (kind === "resident" && section === "financials") {
    // The former "financials" section merged into Payments, which is now
    // Charges-only. Any old financials sub-path lands on the bare `/payments`
    // URL, keeping a status pill where the legacy tab mapped to one.
    const legacy = RESIDENT_PAYMENTS_LEGACY_TABS[tabParts?.[0] ?? ""];
    redirect(
      `${def.basePath}/payments${searchSuffix(
        searchParams,
        legacy?.status ? { status: legacy.status } : undefined,
      )}`,
    );
  }

  // Resident feedback has no sidebar section of its own — it lives in Settings.
  // This must run BEFORE the findSection lookup below, which would otherwise
  // 404 the route and leave the redirect unreachable.
  if (kind === "resident" && section === "bugs-feedback") {
    redirect(`${def.basePath}/profile`);
  }

  // Legacy task-list paths → `/tasks` (bookmarks, emailed links).
  if (section === "task-list") {
    const { legacyTaskListSectionRedirectPath } = await import("@/lib/portal-detail-routes");
    redirect(legacyTaskListSectionRedirectPath(def.basePath, tabParts));
  }

  if (kind === "vendor" && section === "payments") {
    redirect(`${def.basePath}/financials/income`);
  }

  if (kind === "vendor" && section === "tasks") {
    redirect(`${def.basePath}/work-orders/pending`);
  }

  const residentCtx = kind === "resident" ? await getEffectiveSessionForPortal("resident") : null;
  const residentManagerTier =
    kind === "resident" && residentCtx?.profile?.manager_id?.trim()
      ? await getManagerSubscriptionTierByManagerId(residentCtx.profile.manager_id.trim())
      : null;
  const residentAccess =
    kind === "resident"
      ? await loadResidentPortalAccessState({
          userId: residentCtx?.user?.id ?? null,
          role: residentCtx?.profile?.role,
          email: residentCtx?.profile?.email ?? residentCtx?.user?.email ?? null,
          managerSubscriptionTier: residentManagerTier,
        })
      : null;
  if (kind === "resident" && residentAccess) {
    const residentPath = tabParts?.length
      ? `${def.basePath}/${section}/${tabParts.join("/")}`
      : `${def.basePath}/${section}`;
    if (!isResidentPathAllowedForAccess(residentPath, residentAccess)) {
      redirect(residentPortalHomePath(residentAccess));
    }
  }
  const residentWorkspaceUnlocked =
    kind === "resident" ? (residentAccess?.fullPortalAccess ?? false) : false;
  if (kind === "resident" && section === "background-checks") {
    redirect(`${def.basePath}/applications/pending`);
  }
  if (kind === "resident" && section === "applications") {
    const RESIDENT_APP_BUCKETS = ["pending", "approved", "rejected"] as const;
    if (!tabParts?.length) {
      redirect(`${def.basePath}/applications/pending`);
    }
    if (tabParts.length > 2) notFound();
    const tabRaw = tabParts[0]!;
    const applicationBucket = RESIDENT_APP_BUCKETS.includes(
      tabRaw as (typeof RESIDENT_APP_BUCKETS)[number],
    )
      ? (tabRaw as (typeof RESIDENT_APP_BUCKETS)[number])
      : null;
    if (!applicationBucket) {
      notFound();
    }
    if (tabParts.length === 1) {
      return (
        <ResidentApplicationsPanel bucket={applicationBucket} basePath={def.basePath} />
      );
    }
    const applicationId = decodeURIComponent(tabParts[1]!);
    return (
      <ResidentApplicationsPanel
        bucket={applicationBucket}
        basePath={def.basePath}
        applicationId={applicationId}
      />
    );
  }
  // Legacy path support: work-orders moved under Services tabs.
  if (
    (kind === "manager" || kind === "pro") &&
    section === "work-orders"
  ) {
    redirect(`${def.basePath}/services/work-orders`);
  }


  if ((kind === "manager" || kind === "pro") && section === "calendar") {
    const { parseCalendarViewTab, CALENDAR_VIEW_TABS, DEFAULT_CALENDAR_VIEW } = await import("@/lib/portal-detail-routes");
    if (!tabParts?.length) {
      const PortalCalendar = await loadPortalCalendar();
      return <PortalCalendar portal="manager" calendarView={DEFAULT_CALENDAR_VIEW} />;
    }
    const viewRaw = tabParts[0]!;
    if (viewRaw === "bookings") {
      redirect(`${def.basePath}/bookings/upcoming`);
    }
    // `all` is the index; retired names (`schedule`, `availability`) land there too.
    if (viewRaw === DEFAULT_CALENDAR_VIEW || !(CALENDAR_VIEW_TABS as readonly string[]).includes(viewRaw)) {
      redirect(`${def.basePath}/calendar`);
    }
    if (tabParts.length > 1) notFound();
    const PortalCalendar = await loadPortalCalendar();
    return <PortalCalendar portal="manager" calendarView={parseCalendarViewTab(viewRaw)} />;
  }

  // Per-module settings ("bookings", "tours", "applications", …), NOT account
  // settings — that is "profile". The standalone `/portal/settings/<tab>` rail
  // is gone (PLAN-0920-2024); bookmarks and gear "Open in Profile" land on
  // `/portal/profile?tab=…`. Unknown segments 404. Query `?tab=` on the old
  // path is honored so `/portal/settings?tab=inspections` still opens Inspections.
  if ((kind === "manager" || kind === "pro") && section === "settings") {
    if (tabParts && tabParts.length > 1) notFound();
    const queryTab = firstSearchParam(searchParams, "tab");
    const raw = tabParts?.[0] ?? queryTab;
    const hubTab = resolveSettingsRedirectHubTab(raw);
    if (!hubTab) notFound();
    const rest = { ...(searchParams ?? {}) };
    delete rest.tab;
    redirect(`${def.basePath}/profile${searchSuffix(rest, { tab: hubTab })}`);
  }

  // Settings (account entry) sits as its own trailing sidebar group for
  // resident and vendor too, same as pro/manager — see `nav-groups.ts`'s
  // "settings" group. The top-right account menu keeps its own duplicate link.
  if (kind === "resident" && section === "profile") {
    if (tabParts?.length) notFound();
    return <ResidentProfileSection />;
  }
  if (kind === "vendor" && section === "profile") {
    if (tabParts?.length) notFound();
    return <VendorSettingsPanel />;
  }

  const meta = findSection(def, section);
  if (!meta) notFound();

  let managerOwnerSubscriptionTier: "free" | "paid" | null = null;
  let effectiveWorkspaceUserId: string | null = null;
  if (kind === "manager" || kind === "pro") {
    if (kind === "pro") {
      const proRender = await getProPortalRenderContext();
      effectiveWorkspaceUserId = proRender.effectiveUserId;
      managerOwnerSubscriptionTier = proRender.subscriptionTier;
    } else {
      const uid = await getEffectiveUserIdForPortal("manager");
      if (!uid) redirect("/admin/dashboard");
      effectiveWorkspaceUserId = uid;
      managerOwnerSubscriptionTier = await getManagerPortalNavSubscriptionTier(uid);
    }
  }
  const managerPaywall =
    kind === "manager" || kind === "pro"
      ? managerTierPaywall(kind, section, managerOwnerSubscriptionTier, meta.label, def.basePath)
      : null;
  if (managerPaywall) return managerPaywall;

  if (kind === "admin" && section === "dashboard") {
    if (tabParts?.length) notFound();
    const { profile } = await getServerSessionProfile();
    const displayName = profile?.full_name?.trim() || profile?.email?.split("@")[0] || "there";
    return <AdminDashboard displayName={displayName} />;
  }

  if (kind === "admin" && section === "create-manager") {
    if (tabParts?.length) notFound();
    return <AdminCreateManagerClient />;
  }

  if (kind === "admin" && section === "create-resident") {
    if (tabParts?.length) notFound();
    return <AdminCreateResidentClient />;
  }

  if (kind === "admin" && section === "properties") {
    if (tabParts?.length) notFound();
    return <AdminPropertiesClient />;
  }

  if (kind === "admin" && section === "axis-users") {
    if (tabParts?.length) notFound();
    return <AdminAxisUsersClient />;
  }

  if (kind === "admin" && section === "billing") {
    if (tabParts?.length) notFound();
    return <AdminBillingClient />;
  }

  if (kind === "admin" && section === "test-accounts") {
    if (tabParts?.length) notFound();
    if (!isTestWorkspaceFeatureEnabled()) notFound();
    await requireTrustedTestWorkspaceOperator().catch(() => notFound());
    return <AdminTestWorkspacesClient />;
  }

  if (kind === "admin" && section === "leases") {
    redirect(`${def.basePath}/dashboard`);
  }

  if (kind === "admin" && section === "profile") {
    if (tabParts?.length) notFound();
    return <AdminProfileSection />;
  }

  if (kind === "admin" && section === "communication") {
    // The bare section IS the inbox. It used to redirect to
    // `/communication/inbox/unopened`, which made the nav's own href a folder
    // path for a panel that has no folders.
    if (!tabParts?.length) {
      return <AdminCommunication smsUiEnabled={isSmsCommUiEnabled()} />;
    }
    const channel = tabParts[0]!;
    if (channel === "sms" || channel === "email") {
      const legacyTab = tabParts[1] ?? "unopened";
      const mapped =
        legacyTab === "all" || legacyTab === "unopened"
          ? "unopened"
          : legacyTab === "opened"
            ? "opened"
            : legacyTab === "sent"
              ? "sent"
              : legacyTab === "schedule"
                ? "schedule"
                : legacyTab === "trash"
                  ? "trash"
                  : null;
      if (!mapped) notFound();
      redirect(`${def.basePath}/communication/inbox/${mapped}`);
    }
    if (channel === "inbox") {
      const emailTab = tabParts[1] ?? "unopened";
      if (!["unopened", "opened", "schedule", "sent", "trash"].includes(emailTab)) notFound();
      if (tabParts.length > 2) notFound();
      return <AdminCommunication inboxTabId={emailTab as "unopened" | "opened" | "schedule" | "sent" | "trash"} smsUiEnabled={isSmsCommUiEnabled()} />;
    }
    const flatInboxTab = ["unopened", "opened", "schedule", "sent", "trash"] as const;
    if ((flatInboxTab as readonly string[]).includes(channel)) {
      if (tabParts.length > 1) notFound();
      redirect(`${def.basePath}/communication/inbox/${channel}`);
    }
    notFound();
  }

  if (kind === "admin" && section === "bugs-feedback") {
    if (tabParts?.length) notFound();
    return <AdminBugFeedbackClient />;
  }

  if (kind === "admin" && section === "events") {
    if (tabParts?.length) {
      redirect(`${def.basePath}/events`);
    }
    return <AdminEventsClient />;
  }

  if (kind === "manager" || kind === "pro") {
    const reporterRole = kind === "pro" ? "pro" : "manager";

    if (section === "work-orders") {
      redirect(`${def.basePath}/services/work-orders`);
    }

    // Vendors: its own section. `/vendors` is the list, `/vendors/<id>` the detail page.
    if ((kind === "manager" || kind === "pro") && section === "vendors") {
      const vendorId = tabParts?.length ? decodeURIComponent(tabParts[0]!) : undefined;
      if ((tabParts?.length ?? 0) > 2) notFound();
      if (vendorId && (tabParts?.length ?? 0) === 1) {
        redirect(`${def.basePath}/vendors/${encodeURIComponent(vendorId)}/overview`);
      }
      const vendorTab = tabParts && tabParts.length >= 2 ? decodeURIComponent(tabParts[1]!) : undefined;
      const ManagerVendorsPanel = await loadManagerVendorsPanel();
      return subscriptionGated(
        <ManagerVendorsPanel listBasePath={def.basePath} vendorId={vendorId} vendorTab={vendorTab} />,
        kind,
        "vendors",
        managerOwnerSubscriptionTier,
      );
    }

    if ((kind === "manager" || kind === "pro") && section === "relationships") {
      const tail =
        tabParts?.map((part) => `/${encodeURIComponent(decodeURIComponent(part))}`).join("") ?? "";
      redirect(`${def.basePath}/teams/managers${tail}`);
    }

    if ((kind === "manager" || kind === "pro") && section === "teams") {
      if (!tabParts?.length) {
        redirect(`${def.basePath}/teams/managers`);
      }
      const teamTab = tabParts[0]!;
      if (teamTab === "managers") {
        const linkId =
          tabParts.length >= 2 ? decodeURIComponent(tabParts[1]!) : undefined;
        if (tabParts.length > 2) notFound();
        const ProAccountLinksPanel = await loadProAccountLinksPanel();
        return subscriptionGated(
          <ProAccountLinksPanel userId={effectiveWorkspaceUserId!} linkId={linkId} />,
          kind,
          "relationships",
          managerOwnerSubscriptionTier,
        );
      }
      if (teamTab === "vendors") {
        // Vendors were a Teams tab for a while; the path still resolves so bookmarks
        // and links in sent messages keep working, carrying the vendor id through.
        const vendorId =
          tabParts.length >= 2 ? `/${encodeURIComponent(decodeURIComponent(tabParts[1]!))}` : "";
        redirect(`${def.basePath}/vendors${vendorId}`);
      }
      notFound();
    }

    if (kind === "pro") {
      const legacyPath = legacyManagerPortalSectionPath(section);
      if (legacyPath) {
        redirect(`${def.basePath}/${legacyPath}`);
      }
    }

    if (section === "inspections") {
      if (!tabParts?.length) redirect(`${def.basePath}/inspections/move-in`);
      const inspectionKind = tabParts[0];
      if ((inspectionKind !== "move-in" && inspectionKind !== "move-out") || tabParts.length > 3) notFound();
      if (tabParts[1] && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tabParts[1])) notFound();
      const inspectionTab = tabParts[2];
      return subscriptionGated(
        <ManagerInspectionsPage
          kind={inspectionKind}
          reportId={tabParts[1]}
          recordTab={inspectionTab}
          basePath={def.basePath}
        />,
        kind,
        "inspections",
        managerOwnerSubscriptionTier,
      );
    }

    if (section === "residents") {
      if (!tabParts?.length) {
        redirect(`${def.basePath}/${section}/current`);
      }
      const residentsTab = tabParts[0]!;
      if (residentsTab === "previous") {
        const tail = tabParts.slice(1);
        redirect(`${def.basePath}/residents/past${tail.length ? `/${tail.join("/")}` : ""}`);
      }
      const parsedResidentsTab = (
        ["potential", "current", "past"] as const
      ).find((tab) => tab === residentsTab) ?? null;
      if (!parsedResidentsTab) notFound();
      const residentId = tabParts.length >= 2 ? decodeURIComponent(tabParts[1]!) : undefined;
      const residentDetailTabRaw = tabParts.length >= 3 ? tabParts[2]! : undefined;
      if (residentDetailTabRaw === "applicant") {
        const applicantTail = tabParts[3];
        const legacyApplicantTab =
          applicantTail === "background-check" ? "background-check" : "application";
        const tail = tabParts.slice(4).join("/");
        redirect(
          `${def.basePath}/residents/${parsedResidentsTab}/${encodeURIComponent(residentId!)}/${legacyApplicantTab}${tail ? `/${tail}` : ""}`,
        );
      }
      const residentDetailTab = residentDetailTabRaw;
      let residentPaymentId: string | undefined;
      let residentTourBucket: import("@/lib/portal-detail-routes").ManagerTourBucketId | undefined;
      let residentTourId: string | undefined;
      let residentServiceItemId: string | undefined;
      if (residentDetailTab === "tours" && residentId) {
        const { MANAGER_TOUR_BUCKETS, parseManagerTourBucket } = await import(
          "@/lib/portal-detail-routes"
        );
        if (tabParts.length === 3) {
          redirect(
            `${def.basePath}/residents/${parsedResidentsTab}/${encodeURIComponent(residentId)}/tours/pending`,
          );
        }
        const segmentRaw = tabParts[3]!;
        if (MANAGER_TOUR_BUCKETS.includes(segmentRaw as (typeof MANAGER_TOUR_BUCKETS)[number])) {
          residentTourBucket = parseManagerTourBucket(segmentRaw);
          if (tabParts.length === 5) {
            residentTourId = decodeURIComponent(tabParts[4]!);
          } else if (tabParts.length > 4) {
            notFound();
          }
        } else if (tabParts.length === 4) {
          redirect(
            `${def.basePath}/residents/${parsedResidentsTab}/${encodeURIComponent(residentId)}/tours/pending/${encodeURIComponent(segmentRaw)}`,
          );
        } else {
          notFound();
        }
      } else {
        const residentDetailItemId =
          tabParts.length >= 4 ? decodeURIComponent(tabParts[3]!) : undefined;
        residentPaymentId =
          residentDetailTab === "payments" ? residentDetailItemId : undefined;
        residentServiceItemId =
          residentDetailTab === "services" ? residentDetailItemId : undefined;
        if (tabParts.length > 4) notFound();
      }
      const ManagerResidents = await loadManagerResidents();
      return subscriptionGated(
        <ManagerResidents
          tabId={parsedResidentsTab}
          residentId={residentId}
          detailTab={residentDetailTab as import("@/lib/portal-detail-routes").ResidentDetailTabId | undefined}
          paymentId={residentPaymentId}
          tourBucket={residentTourBucket}
          tourId={residentTourId}
          serviceItemId={residentServiceItemId}
          smsUiEnabled={isSmsCommUiEnabled()}
        />,
        kind,
        "residents",
        managerOwnerSubscriptionTier,
      );
    }

    if (section === "communication") {
      const COMM_SEGMENTS = ["active", "unread", "archived"] as const;
      type CommListSegment = (typeof COMM_SEGMENTS)[number];

      if (!tabParts?.length) {
        redirect(`${def.basePath}/communication/active`);
      }

      const channel = tabParts[0]!;
      if (channel === "unread") {
        const threadPart = tabParts[1];
        redirect(
          `${def.basePath}/communication/active${threadPart ? `/${encodeURIComponent(threadPart)}` : ""}`,
        );
      }
      if (channel === "sms") {
        redirect(`${def.basePath}/communication/active`);
      }

      if (channel === "inbox") {
        const legacyTab = tabParts[1] ?? "unopened";
        if (legacyTab === "trash") {
          redirect(`${def.basePath}/communication/archived`);
        }
        if (!isManagerInboxTab(legacyTab)) notFound();
        redirect(`${def.basePath}/communication/active`);
      }

      let threadId: string | undefined;
      if (tabParts.length === 2) {
        threadId = decodeURIComponent(tabParts[1]!);
      } else if (tabParts.length > 2) {
        notFound();
      }

      const segmentRaw = channel;
      const listSegment: CommListSegment = COMM_SEGMENTS.includes(segmentRaw as CommListSegment)
        ? (segmentRaw as CommListSegment)
        : "active";
      if (segmentRaw !== listSegment) {
        redirect(`${def.basePath}/communication/${listSegment}`);
      }

      const ManagerCommunication = await loadManagerCommunication();
      return subscriptionGated(
        <ManagerCommunication
          listSegment={listSegment}
          threadId={threadId}
          smsUiEnabled={isSmsCommUiEnabled()}
        />,
        kind,
        "communication",
        managerOwnerSubscriptionTier,
      );
    }

    if (section === "work-orders" || section === "services") {
      const REQUEST_BUCKETS = ["pending", "approved", "denied"] as const;
      const WO_BUCKETS = ["open", "scheduled", "completed"] as const;

      if (!tabParts?.length) {
        redirect(`${def.basePath}/services/requests/pending`);
      }

      const servicesTab = tabParts[0]!;
      if (servicesTab === "work-done") {
        redirect(`${def.basePath}/financials/expenses`);
      }
      // Vendors are their own section — people a manager works with, not work items. The old
      // path still resolves so bookmarks and links in sent messages keep working, carrying any
      // vendor id through to the detail.
      if (servicesTab === "vendors") {
        const vendorId =
          tabParts.length > 1 ? `/${encodeURIComponent(decodeURIComponent(tabParts[1]!))}` : "";
        redirect(`${def.basePath}/vendors${vendorId}`);
      }
      if (!["requests", "work-orders"].includes(servicesTab)) notFound();

      if (servicesTab === "requests") {
        if (tabParts.length === 1) {
          redirect(`${def.basePath}/services/requests/pending`);
        }
        if (tabParts.length > 4) notFound();
        const bucketRaw = tabParts[1]!;
        const requestBucket = REQUEST_BUCKETS.includes(bucketRaw as typeof REQUEST_BUCKETS[number])
          ? (bucketRaw as typeof REQUEST_BUCKETS[number])
          : "pending";
        if (bucketRaw !== requestBucket) {
          redirect(`${def.basePath}/services/requests/${requestBucket}`);
        }
      } else if (servicesTab === "work-orders") {
        if (tabParts.length === 1) {
          redirect(`${def.basePath}/services/work-orders/open`);
        }
        if (tabParts.length > 4) notFound();
        const bucketRaw = tabParts[1]!;
        const workOrderBucket = WO_BUCKETS.includes(bucketRaw as typeof WO_BUCKETS[number])
          ? (bucketRaw as typeof WO_BUCKETS[number])
          : "open";
        if (bucketRaw !== workOrderBucket) {
          redirect(`${def.basePath}/services/work-orders/${workOrderBucket}`);
        }
      }

      const requestBucket =
        servicesTab === "requests"
          ? (tabParts[1] as typeof REQUEST_BUCKETS[number])
          : undefined;
      const workOrderBucket =
        servicesTab === "work-orders"
          ? (tabParts[1] as typeof WO_BUCKETS[number])
          : undefined;
      const serviceRequestId =
        servicesTab === "requests" && tabParts.length >= 3
          ? decodeURIComponent(tabParts[2]!)
          : undefined;
      const workOrderId =
        servicesTab === "work-orders" && tabParts.length >= 3
          ? decodeURIComponent(tabParts[2]!)
          : undefined;
      // A service record's own rail tab (docs/agents/record-page.md).
      const { parseServiceDetailTab } = await import("@/lib/portal-detail-routes");
      const serviceDetailTabRaw = tabParts.length >= 4 ? tabParts[3]! : undefined;
      const serviceDetailTab =
        serviceRequestId || workOrderId ? parseServiceDetailTab(serviceDetailTabRaw) : undefined;
      if ((serviceRequestId || workOrderId) && serviceDetailTabRaw && serviceDetailTab !== serviceDetailTabRaw) {
        redirect(
          `${def.basePath}/services/${servicesTab}/${tabParts[1]}/${encodeURIComponent(tabParts[2]!)}/${serviceDetailTab}`,
        );
      }

      const ManagerAllServicesPanel = await loadManagerAllServicesPanel();
      return subscriptionGated(
        <ManagerAllServicesPanel
          tabId={servicesTab as "requests" | "work-orders"}
          basePath={def.basePath}
          requestBucket={requestBucket}
          workOrderBucket={workOrderBucket}
          serviceRequestId={serviceRequestId}
          workOrderId={workOrderId}
          serviceDetailTab={serviceDetailTab}
        />,
        kind,
        "services",
        managerOwnerSubscriptionTier,
      );
    }

    if (section === "tasks") {
      const taskTab = tabParts?.[0];
      if (taskTab === "in-progress" && (tabParts?.length ?? 0) <= 1) {
        redirect(`${def.basePath}/tasks`);
      }
      if (taskTab === "late") {
        redirect(`${def.basePath}/tasks/overdue`);
      }
      const { MANAGER_TASK_LIST_TABS, parseManagerTaskListTab } = await import(
        "@/lib/portal-detail-routes"
      );
      if (taskTab && !(MANAGER_TASK_LIST_TABS as readonly string[]).includes(taskTab)) {
        redirect(`${def.basePath}/tasks`);
      }
      if (tabParts && tabParts.length > 3) notFound();
      const taskId =
        tabParts && tabParts.length >= 2 ? decodeURIComponent(tabParts[1]!) : undefined;
      const taskDetailTab =
        tabParts && tabParts.length >= 3 ? decodeURIComponent(tabParts[2]!) : undefined;
      const ManagerTaskList = await loadManagerTaskList();
      return subscriptionGated(
        <ManagerTaskList
          tabId={parseManagerTaskListTab(taskTab)}
          taskId={taskId}
          taskTab={taskDetailTab}
          basePath={def.basePath}
        />,
        kind,
        "tasks",
        managerOwnerSubscriptionTier,
      );
    }

    if (section === "payments") {
      // Payouts is one page now, mounted at Profile → Payouts
      // (`portal-payouts-settings-page.tsx`) — this legacy path is a door to
      // it, never its own render (PLAN-0920-1500 / PLAN-0920-2024).
      if (tabParts?.length === 1 && tabParts[0] === "payouts") {
        redirect(`${def.basePath}/profile?tab=payouts`);
      }

      const PAYMENT_DIRECTIONS = ["incoming", "outgoing"] as const;
      const PAYMENT_BUCKETS = ["pending", "overdue", "paid"] as const;

      if (!tabParts?.length) {
        redirect(`${def.basePath}/payments/incoming/pending`);
      }

      const directionRaw = tabParts[0];
      if (!PAYMENT_DIRECTIONS.includes(directionRaw as typeof PAYMENT_DIRECTIONS[number])) {
        redirect(`${def.basePath}/payments/incoming/pending`);
      }
      const direction = directionRaw as "incoming" | "outgoing";

      if (tabParts.length === 1) {
        redirect(`${def.basePath}/payments/${direction}/pending`);
      }

      if (tabParts.length > 4) {
        redirect(`${def.basePath}/payments/${direction}/pending`);
      }

      const bucketRaw = tabParts[1];
      const bucket = PAYMENT_BUCKETS.includes(bucketRaw as typeof PAYMENT_BUCKETS[number])
        ? (bucketRaw as "pending" | "overdue" | "paid")
        : "pending";

      if (bucketRaw !== bucket) {
        redirect(`${def.basePath}/payments/${direction}/${bucket}`);
      }

      const paymentId =
        tabParts.length >= 3 ? decodeURIComponent(tabParts[2]!) : undefined;
      const paymentTab =
        tabParts.length >= 4 ? decodeURIComponent(tabParts[3]!) : undefined;

      return subscriptionGated(
        <ManagerPayments
          direction={direction}
          bucket={bucket}
          paymentTab={paymentTab}
          basePath={def.basePath}
          paymentId={paymentId}
        />,
        kind,
        "payments",
        managerOwnerSubscriptionTier,
      );
    }

    const financesView = await renderManagerFinancesSection(
      section,
      tabParts,
      def.basePath,
      kind,
      managerOwnerSubscriptionTier,
    );
    if (financesView) return financesView;
    const documentsView = await renderManagerDocumentsSection(
      section,
      tabParts,
      def.basePath,
      kind,
      managerOwnerSubscriptionTier,
    );
    if (documentsView) return documentsView;

    if (section === "leases") {
      const LEASE_TABS = ["manager", "resident", "signed", "completed"] as const;
      if (!tabParts?.length) {
        redirect(`${def.basePath}/leases/manager`);
      }
      if (tabParts.length > 3) notFound();
      const tabRaw = tabParts[0]!;
      const leaseTab = LEASE_TABS.includes(tabRaw as typeof LEASE_TABS[number])
        ? (tabRaw as typeof LEASE_TABS[number])
        : "manager";
      if (tabRaw !== leaseTab) {
        redirect(`${def.basePath}/leases/${leaseTab}`);
      }
      const leaseId = tabParts.length >= 2 ? decodeURIComponent(tabParts[1]!) : undefined;
      const { parseLeaseDetailTab } = await import("@/lib/portal-detail-routes");
      const leaseDetailTabRaw = tabParts.length >= 3 ? tabParts[2]! : undefined;
      const leaseDetailTab = leaseId ? parseLeaseDetailTab(leaseDetailTabRaw) : undefined;
      if (leaseId && leaseDetailTabRaw && leaseDetailTab !== leaseDetailTabRaw) {
        redirect(`${def.basePath}/leases/${leaseTab}/${encodeURIComponent(leaseId)}/${leaseDetailTab}`);
      }
      return subscriptionGated(
        <ManagerLeases tab={leaseTab} basePath={def.basePath} leaseId={leaseId} leaseDetailTab={leaseDetailTab} />,
        kind,
        "leases",
        managerOwnerSubscriptionTier,
      );
    }

    if (section === "background-checks") {
      // Screening now nests inside the application record's own Screening tab
      // (docs/agents/record-page.md, PLAN-0920-1058 area 1c) — the standalone
      // list is gone, so every old link redirects into Applications. A
      // record-carrying link has no reliable bucket to recover here (buckets
      // are resolved client-side from local rows), so it lands on a fixed
      // bucket the same way the older "screenings" alias below does.
      const BG_TABS = ["pending_review", "passed", "flagged"] as const;
      const tabRaw = tabParts?.[0];
      if (tabRaw && !BG_TABS.includes(tabRaw as typeof BG_TABS[number])) notFound();
      const applicationId = tabParts && tabParts.length >= 2 ? tabParts[1] : undefined;
      if (applicationId) {
        redirect(`${def.basePath}/applications/pending/${encodeURIComponent(decodeURIComponent(applicationId))}/screening`);
      }
      redirect(`${def.basePath}/applications/pending`);
    }

    if (section === "applications") {
      const APPLICATION_TABS = ["incomplete", "pending", "approved", "rejected"] as const;
      if (!tabParts?.length) {
        redirect(`${def.basePath}/applications/pending`);
      }
      if (tabParts.length > 3) notFound();
      const tabRaw = tabParts[0]!;
      if (tabRaw === "screenings") {
        const legacyId = tabParts.length >= 2 ? `/${encodeURIComponent(decodeURIComponent(tabParts[1]!))}` : "";
        redirect(`${def.basePath}/applications/approved${legacyId}`);
      }
      const applicationTab = APPLICATION_TABS.includes(tabRaw as typeof APPLICATION_TABS[number])
        ? (tabRaw as typeof APPLICATION_TABS[number])
        : "pending";
      if (tabRaw !== applicationTab) {
        redirect(`${def.basePath}/applications/${applicationTab}`);
      }
      const applicationId = tabParts.length >= 2 ? decodeURIComponent(tabParts[1]!) : undefined;
      const applicationDetailTabRaw = tabParts.length >= 3 ? tabParts[2] : undefined;
      const applicationDetailTab = applicationId ? parseApplicationDetailTab(applicationDetailTabRaw) : undefined;
      if (applicationId && applicationDetailTabRaw && applicationDetailTab !== applicationDetailTabRaw) {
        redirect(`${def.basePath}/applications/${applicationTab}/${encodeURIComponent(applicationId)}/${applicationDetailTab}`);
      }
      const ManagerApplications = await loadManagerApplications();
      return subscriptionGated(
        <ManagerApplications
          bucket={applicationTab}
          basePath={def.basePath}
          applicationId={applicationId}
          applicationDetailTab={applicationDetailTab}
        />,
        kind,
        "applications",
        managerOwnerSubscriptionTier,
      );
    }

    if (section === "screenings") {
      const legacyId = tabParts?.length
        ? `/${tabParts.map((p) => encodeURIComponent(p)).join("/")}`
        : "";
      redirect(`${def.basePath}/applications/approved${legacyId}`);
    }

    if (section === "properties") {
      const { PROPERTY_STAGES } = await import("@/lib/portal-detail-routes");
      if (!tabParts?.length) {
        redirect(`${def.basePath}/properties/all`);
      }
      const stageRaw = tabParts[0]!;
      const stage = PROPERTY_STAGES.includes(stageRaw as (typeof PROPERTY_STAGES)[number])
        ? (stageRaw as (typeof PROPERTY_STAGES)[number])
        : "all";
      if (stageRaw !== stage) {
        redirect(`${def.basePath}/properties/${stage}`);
      }
      if (tabParts.length > 5) notFound();
      const propertyKey = tabParts.length >= 2 ? decodeURIComponent(tabParts[1]!) : undefined;
      const propertyDetailTabRaw = tabParts.length >= 3 ? tabParts[2]! : undefined;
      if (propertyKey && propertyDetailTabRaw === "calendar") {
        redirect(
          `${def.basePath}/properties/${stage}/${encodeURIComponent(propertyKey)}/tours/pending`,
        );
      }
      if (propertyDetailTabRaw === "tour-calendar" && propertyKey) {
        redirect(
          `${def.basePath}/properties/${stage}/${encodeURIComponent(propertyKey)}/tours/pending`,
        );
      }
      if (propertyDetailTabRaw === "booking-calendars" && propertyKey) {
        redirect(
          `${def.basePath}/properties/${stage}/${encodeURIComponent(propertyKey)}/tours/pending`,
        );
      }
      const {
        parsePropertyDetailTab,
        parseManagerTourBucket,
        MANAGER_TOUR_BUCKETS,
      } = await import("@/lib/portal-detail-routes");
      let propertyTourBucket: import("@/lib/portal-detail-routes").ManagerTourBucketId | undefined;
      let propertyTourId: string | undefined;
      if (propertyKey && propertyDetailTabRaw === "tours") {
        if (tabParts.length === 3) {
          redirect(
            `${def.basePath}/properties/${stage}/${encodeURIComponent(propertyKey)}/tours/pending`,
          );
        }
        const bucketRaw = tabParts[3]!;
        if (!MANAGER_TOUR_BUCKETS.includes(bucketRaw as (typeof MANAGER_TOUR_BUCKETS)[number])) {
          notFound();
        }
        propertyTourBucket = parseManagerTourBucket(bucketRaw);
        if (tabParts.length === 5) {
          propertyTourId = decodeURIComponent(tabParts[4]!);
        } else if (tabParts.length > 4) {
          notFound();
        }
      }
      const propertyDetailTab = propertyDetailTabRaw
        ? parsePropertyDetailTab(propertyDetailTabRaw)
        : undefined;
      const ManagerProperties = await loadManagerProperties();
      return subscriptionGated(
        <ManagerProperties
          stage={stage}
          basePath={def.basePath}
          propertyKey={propertyKey}
          detailTab={propertyDetailTab as import("@/lib/portal-detail-routes").PropertyDetailTabId | undefined}
          propertyTourBucket={propertyTourBucket}
          propertyTourId={propertyTourId}
        />,
        kind,
        "properties",
        managerOwnerSubscriptionTier,
      );
    }

    if (section === "promotion") {
      if (tabParts?.length) {
        const segment = tabParts[0]!;
        if (segment === "text" || segment === "image") {
          redirect(`${def.basePath}/promotion`);
        }
        if (tabParts.length > 1) notFound();
        const assetId = decodeURIComponent(segment);
        return subscriptionGated(
          <ManagerPromotion basePath={def.basePath} assetId={assetId} />,
          kind,
          "promotion",
          managerOwnerSubscriptionTier,
        );
      }
      return subscriptionGated(
        <ManagerPromotion basePath={def.basePath} />,
        kind,
        "promotion",
        managerOwnerSubscriptionTier,
      );
    }

    if (section === "bookings") {
      const { MANAGER_BOOKING_BUCKETS, parseManagerBookingBucket, isBookingDayKeySegment } = await import(
        "@/lib/portal-detail-routes"
      );
      if (!tabParts?.length) {
        redirect(`${def.basePath}/bookings/calendar`);
      }
      const segmentRaw = tabParts[0]!;
      const ManagerBookings = await loadManagerBookings();
      // The day page (`/bookings/2026-09-01`) replaces the old day pop-up —
      // a date can never collide with a bucket keyword.
      if (isBookingDayKeySegment(segmentRaw)) {
        if (tabParts.length > 1) notFound();
        return subscriptionGated(
          <ManagerBookings dayKey={segmentRaw} basePath={def.basePath} />,
          kind,
          "bookings",
          managerOwnerSubscriptionTier,
        );
      }
      if (MANAGER_BOOKING_BUCKETS.includes(segmentRaw as (typeof MANAGER_BOOKING_BUCKETS)[number])) {
        if (tabParts.length > 1) notFound();
        const bucket = parseManagerBookingBucket(segmentRaw);
        return subscriptionGated(
          <ManagerBookings bucket={bucket} basePath={def.basePath} />,
          kind,
          "bookings",
          managerOwnerSubscriptionTier,
        );
      }
      // Anything else is a booking record id (`bookingEntryKey`, opaque and
      // URL-encoded) — the booking record page, per docs/agents/record-page.md.
      if (tabParts.length > 2) notFound();
      const bookingId = decodeURIComponent(segmentRaw);
      const bookingTab = tabParts.length === 2 ? decodeURIComponent(tabParts[1]!) : undefined;
      return subscriptionGated(
        <ManagerBookings bookingId={bookingId} bookingTab={bookingTab} basePath={def.basePath} />,
        kind,
        "bookings",
        managerOwnerSubscriptionTier,
      );
    }

    if (section === "tours") {
      const { MANAGER_TOUR_BUCKETS, parseManagerTourBucket, parseTourDetailTab } = await import(
        "@/lib/portal-detail-routes"
      );
      if (!tabParts?.length) {
        redirect(`${def.basePath}/tours/pending`);
      }
      const segmentRaw = tabParts[0]!;
      if (segmentRaw === "tours") {
        redirect(`${def.basePath}/tours/pending`);
      }
      if (segmentRaw === "services" || segmentRaw === "service-orders") {
        redirect(`${def.basePath}/services/requests`);
      }
      if (!MANAGER_TOUR_BUCKETS.includes(segmentRaw as (typeof MANAGER_TOUR_BUCKETS)[number])) {
        notFound();
      }
      if (tabParts.length > 3) notFound();
      const bucket = parseManagerTourBucket(segmentRaw);
      const tourId = tabParts.length >= 2 ? decodeURIComponent(tabParts[1]!) : undefined;
      const tourDetailTabRaw = tabParts.length >= 3 ? tabParts[2]! : undefined;
      const tourDetailTab = tourId ? parseTourDetailTab(tourDetailTabRaw) : undefined;
      if (tourId && tourDetailTabRaw && tourDetailTab !== tourDetailTabRaw) {
        redirect(`${def.basePath}/tours/${bucket}/${encodeURIComponent(tourId)}/${tourDetailTab}`);
      }
      const ManagerTours = await loadManagerTours();
      return subscriptionGated(
        <ManagerTours bucket={bucket} basePath={def.basePath} tourId={tourId} tourDetailTab={tourDetailTab} />,
        kind,
        "tours",
        managerOwnerSubscriptionTier,
      );
    }

    if (tabParts?.length) notFound();

    if (section === "dashboard") {
      const { profile } = await getEffectiveSessionForPortal("manager");
      const displayName = profile?.full_name?.trim() || profile?.email?.split("@")[0] || "there";
      return subscriptionGated(
        <ManagerDashboard displayName={displayName} />,
        kind,
        "dashboard",
        managerOwnerSubscriptionTier,
      );
    }
    if (section === "bugs-feedback") {
      return subscriptionGated(
        <PortalBugFeedbackPanel reporterRole={reporterRole} />,
        kind,
        "bugs-feedback",
        managerOwnerSubscriptionTier,
      );
    }
    if (section === "app") {
      return subscriptionGated(<ManagerMobileAppPanel />, kind, "app", managerOwnerSubscriptionTier);
    }
    if (section === "profile") {
      return subscriptionGated(<ManagerProfile />, kind, "profile", managerOwnerSubscriptionTier);
    }
  }

  if (kind === "resident" && section === "dashboard") {
    if (tabParts?.length) notFound();
    const profile = residentCtx?.profile;
    return (
      <ResidentDashboard
        applicationApproved={residentAccess?.applicationApproved ?? false}
        leaseSigned={residentAccess?.leaseSigned ?? false}
        initialApplicationId={residentAccess?.applicationId ?? null}
        displayName={profile?.full_name ?? profile?.email ?? "Resident"}
        residentEmail={profile?.email ?? residentCtx?.user?.email ?? ""}
        residentUserId={profile?.id ?? residentCtx?.user?.id ?? null}
        managerSubscriptionTier={residentManagerTier}
      />
    );
  }

  if (kind === "resident" && section === "tour") {
    const RESIDENT_TOUR_BUCKETS = ["pending", "confirmed", "declined"] as const;
    if (!tabParts?.length) {
      redirect(`${def.basePath}/tour/pending`);
    }
    if (tabParts.length > 2) notFound();
    const tabRaw = tabParts[0]!;
    const tourBucket = RESIDENT_TOUR_BUCKETS.includes(tabRaw as (typeof RESIDENT_TOUR_BUCKETS)[number])
      ? (tabRaw as (typeof RESIDENT_TOUR_BUCKETS)[number])
      : null;
    if (tourBucket) {
      if (tabParts.length === 1) {
        return <ResidentTourPanel bucket={tourBucket} basePath={def.basePath} />;
      }
      const inquiryId = decodeURIComponent(tabParts[1]!);
      return (
        <ResidentTourPanel bucket={tourBucket} basePath={def.basePath} inquiryId={inquiryId} />
      );
    }
    const legacyInquiryId = decodeURIComponent(tabRaw);
    return <ResidentTourPanel basePath={def.basePath} inquiryId={legacyInquiryId} />;
  }

  if (kind === "resident" && section === "payments") {
    const PAY_BUCKETS = ["pending", "overdue", "paid"] as const;
    if (!tabParts?.length) {
      const legacyStatus = typeof searchParams?.status === "string" ? searchParams.status : undefined;
      const bucket =
        legacyStatus === "overdue" || legacyStatus === "paid" || legacyStatus === "pending"
          ? legacyStatus
          : "pending";
      redirect(`${def.basePath}/payments/${bucket}`);
    }
    if (tabParts.length > 2) notFound();
    const tabRaw = tabParts[0]!;
    const paymentBucket = PAY_BUCKETS.includes(tabRaw as (typeof PAY_BUCKETS)[number])
      ? (tabRaw as (typeof PAY_BUCKETS)[number])
      : "pending";
    if (tabRaw !== paymentBucket) {
      redirect(`${def.basePath}/payments/${paymentBucket}`);
    }
    const chargeId = tabParts.length >= 2 ? decodeURIComponent(tabParts[1]!) : undefined;
    return (
      <ResidentPaymentsPanel
        bucket={paymentBucket}
        basePath={def.basePath}
        chargeId={chargeId}
      />
    );
  }

  if (kind === "resident" && section === "documents") {
    const allowedTabs = meta.tabs.map((t) => t.id);
    if (!tabParts?.length) {
      redirect(`${def.basePath}/${section}/${allowedTabs[0] ?? "application"}`);
    }
    if (tabParts.length > 2) notFound();
    const docTab = tabParts[0]!;
    // "Shared with you" was merged into "Other documents" — keep old deep links alive.
    if (docTab === "shared") redirect(`${def.basePath}/${section}/other`);
    if (!allowedTabs.includes(docTab)) notFound();
    const detailId =
      tabParts.length === 2 ? decodeURIComponent(tabParts[1]!) : undefined;
    if (
      tabParts.length === 2 &&
      docTab !== "application" &&
      docTab !== "lease" &&
      docTab !== "receipts"
    ) {
      notFound();
    }
    const applicationId = docTab === "application" ? detailId : undefined;
    const leaseId = docTab === "lease" ? detailId : undefined;
    const receiptId = docTab === "receipts" ? detailId : undefined;
    const tierGate = residentManagerTierGate("documents", residentManagerTier, meta.label);
    if (tierGate) return tierGate;
    return (
      <ResidentDocumentsPanel
        tabId={docTab}
        basePath={def.basePath}
        tabs={meta.tabs}
        applicationId={applicationId}
        leaseId={leaseId}
        receiptId={receiptId}
      />
    );
  }

  if (kind === "resident" && section === "lease") {
    const LEASE_BUCKETS = ["pending", "signed"] as const;
    if (!tabParts?.length) {
      redirect(`${def.basePath}/lease/pending`);
    }
    if (tabParts.length > 2) notFound();
    const tabRaw = tabParts[0]!;
    const leaseBucket = LEASE_BUCKETS.includes(tabRaw as (typeof LEASE_BUCKETS)[number])
      ? (tabRaw as (typeof LEASE_BUCKETS)[number])
      : null;
    if (!leaseBucket) {
      const legacyDetailId = decodeURIComponent(tabRaw);
      return <ResidentLeasePanel basePath={def.basePath} leaseDetailId={legacyDetailId} />;
    }
    if (tabParts.length === 1) {
      return <ResidentLeasePanel basePath={def.basePath} bucket={leaseBucket} />;
    }
    const leaseDetailId = decodeURIComponent(tabParts[1]!);
    return (
      <ResidentLeasePanel
        basePath={def.basePath}
        bucket={leaseBucket}
        leaseDetailId={leaseDetailId}
      />
    );
  }

  if (kind === "resident" && section === "inspections") {
    // Locked until the lease is signed, like My home — there is no room to inspect before then.
    if (!residentAccess?.leaseAccessUnlocked) redirect(`${def.basePath}/dashboard`);
    if (!tabParts?.length) redirect(`${def.basePath}/inspections/move-in`);
    const inspectionKind = tabParts[0];
    if ((inspectionKind !== "move-in" && inspectionKind !== "move-out") || tabParts.length > 2) notFound();
    if (tabParts[1] && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tabParts[1])) notFound();
    return <ResidentInspectionsPage kind={inspectionKind} reportId={tabParts[1]} basePath={def.basePath} />;
  }

  if (kind === "resident" && section === "move-in") {
    // The old My home → Inspections sub-tab is its own section now; keep the URL alive.
    if (tabParts?.[0] === "inspections") redirect(`${def.basePath}/inspections/move-in`);
    const moveInEmail = residentCtx?.profile?.email ?? residentCtx?.user?.email ?? null;
    const allowedTabs = meta.tabs.map((t) => t.id);
    // Use the same entitlement as navigation, including attested off-platform tenancies.
    if (!residentAccess?.leaseAccessUnlocked) {
      return (
        <ManagerPortalPageShell title="My home" hideTitleOnMobileNav>
          <ResidentMoveInShell
            basePath={def.basePath}
            resolved={null}
            email={moveInEmail?.trim().toLowerCase() ?? ""}
            locked
          />
        </ManagerPortalPageShell>
      );
    }
    if (!tabParts?.length) {
      redirect(`${def.basePath}/move-in/${allowedTabs[0] ?? "placement"}`);
    }
    if (tabParts.length > 1) notFound();
    const moveInTab = tabParts[0]!;
    // A retired sub-tab keeps its URL: the "Move-in" tab's arrival details now render under
    // Info & rules, and a bookmark or an emailed link must land there rather than 404.
    if (!allowedTabs.includes(moveInTab)) {
      const alias = parseResidentMoveInTab(moveInTab);
      if (alias !== "placement" && allowedTabs.includes(alias)) redirect(`${def.basePath}/move-in/${alias}`);
      notFound();
    }
    return (
      <ResidentMoveInPanel
        residentEmail={moveInEmail}
        basePath={def.basePath}
        tabId={moveInTab}
        tabs={meta.tabs}
        focusRoomId={typeof searchParams?.room === "string" ? searchParams.room : undefined}
      />
    );
  }

  if (kind === "resident" && section === "communication") {
    const tierGate = residentManagerTierGate("communication", residentManagerTier, meta.label);
    if (tierGate) return tierGate;

    const COMM_SEGMENTS = ["active", "unread", "archived"] as const;
    type CommListSegment = (typeof COMM_SEGMENTS)[number];

    if (!tabParts?.length) {
      redirect(`${def.basePath}/communication/active`);
    }

    const channel = tabParts[0]!;
    if (channel === "unread") {
      const threadPart = tabParts[1];
      redirect(
        `${def.basePath}/communication/active${threadPart ? `/${encodeURIComponent(threadPart)}` : ""}`,
      );
    }
    if (channel === "sms" || channel === "email") {
      redirect(`${def.basePath}/communication/active`);
    }

    if (channel === "inbox") {
      const legacyTab = tabParts[1] ?? "unopened";
      if (legacyTab === "trash") {
        redirect(`${def.basePath}/communication/archived`);
      }
      redirect(`${def.basePath}/communication/active`);
    }

    let threadId: string | undefined;
    if (tabParts.length === 2) {
      threadId = decodeURIComponent(tabParts[1]!);
    } else if (tabParts.length > 2) {
      notFound();
    }

    const segmentRaw = channel;
    const listSegment: CommListSegment = COMM_SEGMENTS.includes(segmentRaw as CommListSegment)
      ? (segmentRaw as CommListSegment)
      : "active";
    if (segmentRaw !== listSegment) {
      redirect(`${def.basePath}/communication/${listSegment}`);
    }

    return (
      <ResidentCommunication
        listSegment={listSegment}
        threadId={threadId}
        smsUiEnabled={isSmsCommUiEnabled()}
        residentUserId={residentCtx?.user?.id ?? residentCtx?.profile?.id ?? null}
      />
    );
  }

  if (kind === "resident") {
    if (residentWorkspaceUnlocked) {
      if (section === "services") {
        const tierGate = residentManagerTierGate("services", residentManagerTier, meta.label);
        if (tierGate) return tierGate;
        if (tabParts?.length) {
          const legacy = tabParts[0]!;
          if (legacy === "requests" || legacy === "work-orders") {
            redirect(`${def.basePath}/services`);
          }
          // A service RECORD id (PLAN-0920-1058, area 1c): /services/<id>/<tab>.
          if (tabParts.length > 2) notFound();
          const { parseResidentServiceDetailTab } = await import("@/lib/portal-detail-routes");
          const serviceId = decodeURIComponent(legacy);
          const detailTabRaw = tabParts.length === 2 ? tabParts[1]! : undefined;
          const detailTab = parseResidentServiceDetailTab(detailTabRaw);
          if (detailTabRaw && detailTab !== detailTabRaw) {
            redirect(`${def.basePath}/services/${encodeURIComponent(serviceId)}/${detailTab}`);
          }
          const ResidentServicesPanel = await loadResidentServicesPanel();
          return (
            <ResidentServicesPanel
              basePath={def.basePath}
              serviceId={serviceId}
              serviceDetailTab={detailTab}
            />
          );
        }
        const ResidentServicesPanel = await loadResidentServicesPanel();
        return <ResidentServicesPanel basePath={def.basePath} />;
      }
      if (tabParts?.length) notFound();
      if (section === "work-orders") {
        redirect(`${def.basePath}/services`);
      }
    }
  }

  if (kind === "vendor" && section === "dashboard") {
    if (tabParts?.length) notFound();
    const { profile } = await getEffectiveSessionForPortal("vendor");
    return <VendorDashboard displayName={profile?.full_name?.trim() || "there"} />;
  }

  if (kind === "vendor" && section === "work-orders") {
    const {
      parseVendorWorkOrderListTab,
      DEFAULT_VENDOR_WORK_ORDER_TAB,
      VENDOR_WORK_ORDER_LIST_TABS,
      VENDOR_WORK_ORDER_LEGACY_LIST_TABS,
      vendorWorkOrderListHref,
      parseVendorJobDetailTab,
    } = await import("@/lib/portal-detail-routes");
    if (!tabParts?.length) {
      redirect(vendorWorkOrderListHref(def.basePath, DEFAULT_VENDOR_WORK_ORDER_TAB));
    }
    const raw = tabParts[0]!;
    if (VENDOR_WORK_ORDER_LEGACY_LIST_TABS[raw]) {
      redirect(vendorWorkOrderListHref(def.basePath, VENDOR_WORK_ORDER_LEGACY_LIST_TABS[raw]!));
    }
    if (!(VENDOR_WORK_ORDER_LIST_TABS as readonly string[]).includes(raw)) {
      // Not a known list tab — a vendor job RECORD id (PLAN-0920-1058, area 1c).
      if (tabParts.length > 2) notFound();
      const workOrderId = decodeURIComponent(raw);
      const detailTabRaw = tabParts.length === 2 ? tabParts[1]! : undefined;
      const detailTab = parseVendorJobDetailTab(detailTabRaw);
      if (detailTabRaw && detailTab !== detailTabRaw) {
        redirect(`${def.basePath}/work-orders/${encodeURIComponent(workOrderId)}/${detailTab}`);
      }
      return (
        <VendorWorkOrdersPanel
          tabId={DEFAULT_VENDOR_WORK_ORDER_TAB}
          workOrderId={workOrderId}
          workOrderDetailTab={detailTab}
        />
      );
    }
    if (tabParts.length > 1) notFound();
    return <VendorWorkOrdersPanel tabId={parseVendorWorkOrderListTab(raw)} />;
  }

  if (kind === "vendor" && section === "calendar") {
    const {
      parseVendorCalendarViewTab,
      VENDOR_CALENDAR_VIEW_TABS,
      vendorCalendarViewHref,
      DEFAULT_VENDOR_CALENDAR_VIEW,
    } = await import("@/lib/portal-detail-routes");
    if (tabParts && tabParts.length > 1) notFound();
    const raw = tabParts?.[0];
    if (raw === "tasks" || raw === "tours" || raw === "all" || raw === "services") {
      redirect(vendorCalendarViewHref(def.basePath, DEFAULT_VENDOR_CALENDAR_VIEW));
    }
    if (raw && !(VENDOR_CALENDAR_VIEW_TABS as readonly string[]).includes(raw)) notFound();
    const PortalCalendar = await loadPortalCalendar();
    return <PortalCalendar portal="vendor" vendorCalendarView={parseVendorCalendarViewTab(raw)} />;
  }

  if (kind === "vendor" && section === "communication") {
    const COMM_SEGMENTS = ["active", "unread", "archived"] as const;
    type CommListSegment = (typeof COMM_SEGMENTS)[number];

    if (!tabParts?.length) {
      redirect(`${def.basePath}/communication/active`);
    }

    const channel = tabParts[0]!;
    if (channel === "unread") {
      const threadPart = tabParts[1];
      redirect(
        `${def.basePath}/communication/active${threadPart ? `/${encodeURIComponent(threadPart)}` : ""}`,
      );
    }
    if (channel === "sms" || channel === "email") {
      redirect(`${def.basePath}/communication/active`);
    }

    if (channel === "inbox") {
      const legacyTab = tabParts[1] ?? "unopened";
      if (legacyTab === "trash") {
        redirect(`${def.basePath}/communication/archived`);
      }
      redirect(`${def.basePath}/communication/active`);
    }

    let threadId: string | undefined;
    if (tabParts.length === 2) {
      threadId = decodeURIComponent(tabParts[1]!);
    } else if (tabParts.length > 2) {
      notFound();
    }

    const segmentRaw = channel;
    const listSegment: CommListSegment = COMM_SEGMENTS.includes(segmentRaw as CommListSegment)
      ? (segmentRaw as CommListSegment)
      : "active";
    if (segmentRaw !== listSegment) {
      redirect(`${def.basePath}/communication/${listSegment}`);
    }

    return (
      <VendorCommunication
        listSegment={listSegment}
        threadId={threadId}
        smsUiEnabled={isSmsCommUiEnabled()}
      />
    );
  }

  if (kind === "vendor" && section === "financials") {
    if (!meta.tabs.length) notFound();
    if (!tabParts?.length) {
      redirect(`${def.basePath}/financials/income`);
    }
    const finTab = tabParts[0]!;
    if (!meta.tabs.some((tab) => tab.id === finTab)) notFound();

    if (finTab === "invoices" || finTab === "payouts") {
      // A record under this tab: /financials/invoices|payouts/<id>/<tab>
      // (PLAN-0920-1058, area 1c).
      if (tabParts.length > 3) notFound();
      if (tabParts.length === 1) {
        // Payouts is one page now, mounted at Settings → Payouts (vendor twin
        // of the manager redirect above) — the bare Finances tab is a door to
        // it, never its own render (PLAN-0920-1500). A payout record below
        // still renders here.
        if (finTab === "payouts") {
          redirect(`${def.basePath}/profile?tab=payouts`);
        }
        return <VendorFinancesPanel tabId={finTab} basePath={def.basePath} />;
      }
      if (tabParts.length === 2 && tabParts[1] === "pending") {
        redirect(`${def.basePath}/financials/${finTab}`);
      }
      const { parseVendorInvoiceDetailTab, parseVendorPayoutDetailTab } = await import(
        "@/lib/portal-detail-routes"
      );
      const recordId = decodeURIComponent(tabParts[1]!);
      const detailTabRaw = tabParts.length === 3 ? tabParts[2]! : undefined;
      const detailTab =
        finTab === "invoices"
          ? parseVendorInvoiceDetailTab(detailTabRaw)
          : parseVendorPayoutDetailTab(detailTabRaw);
      if (detailTabRaw && detailTab !== detailTabRaw) {
        redirect(`${def.basePath}/financials/${finTab}/${encodeURIComponent(recordId)}/${detailTab}`);
      }
      return (
        <VendorFinancesPanel
          tabId={finTab}
          basePath={def.basePath}
          recordId={recordId}
          recordDetailTab={detailTab}
        />
      );
    }

    if (tabParts.length > 1) {
      if (tabParts.length === 2 && tabParts[1] === "pending") {
        redirect(`${def.basePath}/financials/${tabParts[0]}`);
      }
      notFound();
    }
    return <VendorFinancesPanel tabId={finTab} basePath={def.basePath} />;
  }

  if (kind === "vendor" && section === "documents") {
    if (!meta.tabs.length) notFound();
    if (!tabParts?.length) {
      redirect(`${def.basePath}/${section}/${meta.tabs[0]!.id}`);
    }
    if (tabParts.length > 1) {
      if (tabParts.length === 2 && tabParts[1] === "pending") {
        redirect(`${def.basePath}/${section}/${tabParts[0]}`);
      }
      notFound();
    }
    const documentsTab = tabParts[0]!;
    // The category and former source tabs collapsed into one source-filtered list. A vendor's
    // bookmark, or a manager's emailed link, must still land somewhere.
    if (["tax", "insurance", "licensing", "mine", "shared"].includes(documentsTab)) {
      redirect(`${def.basePath}/${section}/all`);
    }
    if (!meta.tabs.some((tab) => tab.id === documentsTab)) notFound();
    return <VendorDocumentsPanel tabId={documentsTab} basePath={def.basePath} />;
  }


  if (!meta.tabs.length) {
    if (tabParts?.length) notFound();
  } else if (!tabParts?.length) {
    redirect(`${def.basePath}/${section}/${meta.tabs[0].id}`);
  }

  const tabId = meta.tabs.length ? (tabParts?.[0] ?? meta.tabs[0].id) : "index";
  if (meta.tabs.length && !meta.tabs.some((t) => t.id === tabId)) notFound();

  const modelTab = tabId === "index" ? "overview" : tabId;
  const model = buildPortalWorkspaceModel(kind, section, modelTab);

  const tabs: TabItem[] = meta.tabs.map((t) => ({
    id: t.id,
    label: t.label,
    href: `${def.basePath}/${section}/${t.id}`,
  }));

  const tabLabel = meta.tabs.find((t) => t.id === tabId)?.label ?? "Overview";

  const breadcrumbs: Crumb[] = [
    { label: "Home", href: "/" },
    { label: def.title, href: `${def.basePath}/dashboard` },
    { label: meta.label, href: meta.tabs.length ? `${def.basePath}/${section}/${meta.tabs[0].id}` : `${def.basePath}/${section}` },
    ...(meta.tabs.length ? [{ label: tabLabel }] : []),
  ];

  return (
    <PortalWorkspaceClient
      portalKind={kind}
      portalLabel={def.title}
      tabId={meta.tabs.length ? tabId : "index"}
      tabs={tabs}
      model={model}
      breadcrumbs={breadcrumbs}
    />
  );
}
