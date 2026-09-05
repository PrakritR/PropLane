import { isSmsCommUiEnabled } from "@/lib/sms-comm-ui-flag.server";
import { AdminDashboard } from "@/components/portal/admin-dashboard";
import { ManagerDashboard } from "@/components/portal/pro-dashboard";
import { ManagerLeases } from "@/components/portal/pro-leases";
import { ManagerPayments } from "@/components/portal/pro-payments";
import { ManagerPromotion } from "@/components/portal/pro-promotion";
import { ManagerMobileAppPanel } from "@/components/portal/pro-mobile-app-panel";
import { PortalStripeConnectPanel } from "@/components/portal/portal-stripe-connect-panel";
import { ManagerProfile } from "@/components/portal/pro-profile";
import { AdminCreateManagerClient } from "@/components/portal/admin-create-manager-client";
import { AdminCreateResidentClient } from "@/components/portal/admin-create-resident-client";
import { AdminAxisUsersClient } from "@/components/portal/admin-axis-users-client";
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
import { ResidentProfilePanel } from "@/components/portal/resident-profile-panel";
import { PortalBugFeedbackPanel } from "@/components/portal/portal-bug-feedback-panel";
import { VendorDashboard } from "@/components/portal/vendor-dashboard";
import { VendorWorkOrdersPanel } from "@/components/portal/vendor-work-orders-panel";
import { VendorCalendarPanel } from "@/components/portal/vendor-calendar-panel";
import { VendorTaskList } from "@/components/portal/vendor-task-list";
import { VendorFinancesPanel } from "@/components/portal/vendor-finances-panel";
import { VendorPaymentsPanel } from "@/components/portal/vendor-payments-panel";
import { VendorDocumentsPanel } from "@/components/portal/vendor-documents-panel";
import { VendorSettingsPanel } from "@/components/portal/vendor-settings-panel";
import { ManagerPortalPageShell, PORTAL_INLINE_UNLOCK_NOTICE_CLASS } from "@/components/portal/portal-metrics";
import { PortalTierPaywall } from "@/components/portal/portal-tier-paywall";
import { PortalWorkspaceClient } from "@/components/portal/portal-workspace-client";
import {
  loadManagerAllServicesPanel,
  loadManagerTaskList,
  loadManagerTours,
  loadManagerApplications,
  loadManagerBackgroundChecks,
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
import { loadResidentLeaseSignedStatus, loadResidentPortalAccessState, residentPortalHomePath } from "@/lib/resident-portal-access";
import { isResidentPathAllowedForAccess } from "@/lib/resident-portal-nav";
import { findSection, getPortalDefinition } from "@/lib/portals";
import { MANAGER_PLAN_PORTAL_URL } from "@/lib/portals/manager-plan-path";
import { RESIDENT_PAYMENTS_LEGACY_TABS } from "@/lib/portals/resident-sections";
import { getProPortalRenderContext } from "@/lib/portals/pro-nav";
import { buildPortalWorkspaceModel } from "@/lib/portal-workspace-model";
import { legacyManagerPortalSectionPath, parseApplicationDetailTab } from "@/lib/portal-detail-routes";
import type { PortalKind } from "@/lib/portal-types";
import { notFound, redirect } from "next/navigation";
import { DEFERRED_SECTIONS } from "@/lib/portals/nav-locks";

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
const FINANCIALS_TABS = ["income", "expenses", "trial-balance", "balance-sheet", "general-ledger", "cash-flow-statement", "payout-history", "trust-account-balance", "security-deposits", "financial-diagnostics", "ap-aging", "bills", "budget-vs-actual", "bank-reconciliation", "owner-statement", "owner-distributions"] as const;

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
    redirect(`${basePath}/financials/income`);
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
  if (!DOCUMENTS_TABS.includes(docTab as (typeof DOCUMENTS_TABS)[number])) notFound();
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

function ResidentFreeTierFeatureNotice({ title }: { title: string }) {
  return (
    <ManagerPortalPageShell title={title} hideTitleOnMobileNav>
      <p className={PORTAL_INLINE_UNLOCK_NOTICE_CLASS}>
        <span className="font-semibold">Awaiting your property manager.</span> Access to {title.toLowerCase()} is not
        available while the property team is on the Free plan. They can enable this feature by upgrading to Pro or
        Business.
      </p>
    </ManagerPortalPageShell>
  );
}

function residentManagerTierGate(
  section: string,
  managerTier: "free" | "paid" | null,
  featureLabel: string,
): ReactNode | null {
  if (residentSectionAllowedForManagerTier(section, managerTier)) return null;
  return <ResidentFreeTierFeatureNotice title={featureLabel} />;
}

export type PortalSearchParams = Record<string, string | string[] | undefined>;

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


  if ((kind === "manager" || kind === "pro") && section === "bookings") {
    if (tabParts?.length) notFound();
    const PortalCalendar = await loadPortalCalendar();
    return <PortalCalendar portal="manager" calendarView="bookings" bookingsPage />;
  }

  if ((kind === "manager" || kind === "pro") && section === "calendar") {
    const { parseCalendarViewTab } = await import("@/lib/portal-detail-routes");
    if (!tabParts?.length) {
      const PortalCalendar = await loadPortalCalendar();
      return <PortalCalendar portal="manager" calendarView="availability" />;
    }
    const viewRaw = tabParts[0]!;
    if (viewRaw === "bookings") {
      redirect(`${def.basePath}/bookings`);
    }
    if (viewRaw === "availability") {
      redirect(`${def.basePath}/calendar`);
    }
    // Retired view names — and the Tours hub's own — land on Schedule rather than 404ing.
    if (viewRaw !== "availability" && parseCalendarViewTab(viewRaw) !== "availability") {
      redirect(`${def.basePath}/calendar`);
    }
    if (tabParts.length > 1) notFound();
    const PortalCalendar = await loadPortalCalendar();
    return <PortalCalendar portal="manager" calendarView="availability" />;
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

    // Vendors moved to Teams — they are people a manager works with, not work items.
    if ((kind === "manager" || kind === "pro") && section === "vendors") {
      const tail =
        tabParts?.map((part) => `/${encodeURIComponent(decodeURIComponent(part))}`).join("") ?? "";
      redirect(`${def.basePath}/teams/vendors${tail}`);
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
        const vendorId =
          tabParts.length >= 2 ? decodeURIComponent(tabParts[1]!) : undefined;
        if (tabParts.length > 2) notFound();
        const ManagerVendorsPanel = await loadManagerVendorsPanel();
        return subscriptionGated(
          <ManagerVendorsPanel
            listBasePath={def.basePath}
            vendorId={vendorId}
          />,
          kind,
          "vendors",
          managerOwnerSubscriptionTier,
        );
      }
      notFound();
    }

    if (kind === "pro") {
      const legacyPath = legacyManagerPortalSectionPath(section);
      if (legacyPath) {
        redirect(`${def.basePath}/${legacyPath}`);
      }
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
      const parsedResidentsTab = residentsTab === "past" ? "past" : residentsTab === "current" ? "current" : null;
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
      const residentDetailItemId =
        tabParts.length >= 4 ? decodeURIComponent(tabParts[3]!) : undefined;
      const residentPaymentId =
        residentDetailTab === "payments" ? residentDetailItemId : undefined;
      const residentTourId = residentDetailTab === "tours" ? residentDetailItemId : undefined;
      const residentServiceItemId =
        residentDetailTab === "services" ? residentDetailItemId : undefined;
      if (tabParts.length > 4) notFound();
      const ManagerResidents = await loadManagerResidents();
      return subscriptionGated(
        <ManagerResidents
          tabId={parsedResidentsTab}
          residentId={residentId}
          detailTab={residentDetailTab as import("@/lib/portal-detail-routes").ResidentDetailTabId | undefined}
          paymentId={residentPaymentId}
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
      // Vendors moved to Team — they are people a manager works with, not work items. The old
      // path still resolves so bookmarks and links in sent messages keep working, carrying any
      // vendor id through to the detail.
      if (servicesTab === "vendors") {
        const vendorId =
          tabParts.length > 1 ? `/${encodeURIComponent(decodeURIComponent(tabParts[1]!))}` : "";
        redirect(`${def.basePath}/teams/vendors${vendorId}`);
      }
      if (!["requests", "work-orders"].includes(servicesTab)) notFound();

      if (servicesTab === "requests") {
        if (tabParts.length === 1) {
          redirect(`${def.basePath}/services/requests/pending`);
        }
        if (tabParts.length > 3) notFound();
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
        if (tabParts.length > 3) notFound();
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

      const ManagerAllServicesPanel = await loadManagerAllServicesPanel();
      return subscriptionGated(
        <ManagerAllServicesPanel
          tabId={servicesTab as "requests" | "work-orders"}
          basePath={def.basePath}
          requestBucket={requestBucket}
          workOrderBucket={workOrderBucket}
          serviceRequestId={serviceRequestId}
          workOrderId={workOrderId}
        />,
        kind,
        "services",
        managerOwnerSubscriptionTier,
      );
    }

    if (section === "tasks") {
      const taskTab = tabParts?.[0];
      if (taskTab === "in-progress") {
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
      if (tabParts && tabParts.length > 1) notFound();
      const ManagerTaskList = await loadManagerTaskList();
      return subscriptionGated(
        <ManagerTaskList
          tabId={parseManagerTaskListTab(taskTab)}
          basePath={def.basePath}
        />,
        kind,
        "tasks",
        managerOwnerSubscriptionTier,
      );
    }

    if (section === "payments") {
      if (tabParts?.length === 1 && tabParts[0] === "payouts") {
        return subscriptionGated(
          <PortalStripeConnectPanel basePath={def.basePath} />,
          kind,
          "payments",
          managerOwnerSubscriptionTier,
        );
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

      if (tabParts.length > 3) {
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

      return subscriptionGated(
        <ManagerPayments
          direction={direction}
          bucket={bucket}
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
      if (tabParts.length > 2) notFound();
      const tabRaw = tabParts[0]!;
      const leaseTab = LEASE_TABS.includes(tabRaw as typeof LEASE_TABS[number])
        ? (tabRaw as typeof LEASE_TABS[number])
        : "manager";
      if (tabRaw !== leaseTab) {
        redirect(`${def.basePath}/leases/${leaseTab}`);
      }
      const leaseId = tabParts.length >= 2 ? decodeURIComponent(tabParts[1]!) : undefined;
      return subscriptionGated(
        <ManagerLeases tab={leaseTab} basePath={def.basePath} leaseId={leaseId} />,
        kind,
        "leases",
        managerOwnerSubscriptionTier,
      );
    }

    if (section === "background-checks") {
      const BG_TABS = ["pending_review", "passed", "flagged"] as const;
      if (!tabParts?.length) {
        redirect(`${def.basePath}/background-checks/pending_review`);
      }
      if (tabParts.length > 2) notFound();
      const tabRaw = tabParts[0]!;
      const bgTab = BG_TABS.includes(tabRaw as typeof BG_TABS[number])
        ? (tabRaw as typeof BG_TABS[number])
        : "pending_review";
      if (tabRaw !== bgTab) {
        redirect(`${def.basePath}/background-checks/${bgTab}`);
      }
      const applicationId = tabParts.length >= 2 ? decodeURIComponent(tabParts[1]!) : undefined;
      const ManagerBackgroundChecks = await loadManagerBackgroundChecks();
      return subscriptionGated(
        <ManagerBackgroundChecks tab={bgTab} basePath={def.basePath} applicationId={applicationId} />,
        kind,
        "background-checks",
        managerOwnerSubscriptionTier,
      );
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
      const applicationDetailTab =
        tabParts.length >= 3 ? parseApplicationDetailTab(tabParts[2]) : "application";
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
        redirect(`${def.basePath}/properties/listed`);
      }
      const stageRaw = tabParts[0]!;
      const stage = PROPERTY_STAGES.includes(stageRaw as (typeof PROPERTY_STAGES)[number])
        ? (stageRaw as (typeof PROPERTY_STAGES)[number])
        : "listed";
      if (stageRaw !== stage) {
        redirect(`${def.basePath}/properties/${stage}`);
      }
      if (tabParts.length > 4) notFound();
      const propertyKey = tabParts.length >= 2 ? decodeURIComponent(tabParts[1]!) : undefined;
      const propertyDetailTabRaw = tabParts.length >= 3 ? tabParts[2]! : undefined;
      if (propertyKey && propertyDetailTabRaw === "calendar") {
        redirect(
          `${def.basePath}/properties/${stage}/${encodeURIComponent(propertyKey)}/tours`,
        );
      }
      if (propertyDetailTabRaw === "tour-calendar" && propertyKey) {
        redirect(
          `${def.basePath}/properties/${stage}/${encodeURIComponent(propertyKey)}/tours`,
        );
      }
      if (propertyDetailTabRaw === "booking-calendars" && propertyKey) {
        redirect(
          `${def.basePath}/properties/${stage}/${encodeURIComponent(propertyKey)}/tours`,
        );
      }
      const { parsePropertyDetailTab } = await import("@/lib/portal-detail-routes");
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

    if (section === "tours") {
      const { MANAGER_TOUR_BUCKETS, parseManagerTourBucket } = await import("@/lib/portal-detail-routes");
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
      if (tabParts.length > 2) notFound();
      const bucket = parseManagerTourBucket(segmentRaw);
      const tourId = tabParts.length === 2 ? decodeURIComponent(tabParts[1]!) : undefined;
      const ManagerTours = await loadManagerTours();
      return subscriptionGated(
        <ManagerTours bucket={bucket} basePath={def.basePath} tourId={tourId} />,
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

  if (kind === "resident" && section === "profile") {
    if (tabParts?.length) notFound();
    return <ResidentProfilePanel />;
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

  if (kind === "resident" && section === "move-in") {
    const moveInEmail = residentCtx?.profile?.email ?? residentCtx?.user?.email ?? null;
    const allowedTabs = meta.tabs.map((t) => t.id);
    const leaseSigned = moveInEmail ? await loadResidentLeaseSignedStatus(moveInEmail) : false;
    if (!leaseSigned) {
      return (
        <ManagerPortalPageShell title="House details" hideTitleOnMobileNav>
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
    if (!allowedTabs.includes(moveInTab)) notFound();
    return (
      <ResidentMoveInPanel
        residentEmail={moveInEmail}
        basePath={def.basePath}
        tabId={moveInTab}
        tabs={meta.tabs}
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
          const legacy = tabParts[0];
          if (legacy === "requests" || legacy === "work-orders") {
            redirect(`${def.basePath}/services`);
          }
          notFound();
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
    if (tabParts?.length) notFound();
    return <VendorWorkOrdersPanel />;
  }

  if (kind === "vendor" && section === "tasks") {
    const { VENDOR_TASK_LIST_TABS, parseVendorTaskListTab } = await import(
      "@/lib/portal-detail-routes"
    );
    const taskTab = tabParts?.[0];
    if (taskTab === "in-progress") {
      redirect(`${def.basePath}/tasks`);
    }
    if (taskTab && !(VENDOR_TASK_LIST_TABS as readonly string[]).includes(taskTab)) {
      redirect(`${def.basePath}/tasks`);
    }
    if (tabParts && tabParts.length > 1) notFound();
    return (
      <VendorTaskList tabId={parseVendorTaskListTab(taskTab)} basePath={def.basePath} />
    );
  }

  if (kind === "vendor" && section === "calendar") {
    if (tabParts?.length) notFound();
    return <VendorCalendarPanel />;
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
    if (tabParts.length > 1) {
      if (tabParts.length === 2 && tabParts[1] === "pending") {
        redirect(`${def.basePath}/financials/${tabParts[0]}`);
      }
      notFound();
    }
    const finTab = tabParts[0]!;
    if (!meta.tabs.some((tab) => tab.id === finTab)) notFound();
    return <VendorFinancesPanel tabId={finTab} basePath={def.basePath} />;
  }

  if (kind === "vendor" && section === "payments") {
    if (tabParts?.length) notFound();
    return <VendorPaymentsPanel />;
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
    // The three category tabs collapsed into one "Mine" list. A vendor's
    // bookmark, or a manager's emailed link, must still land somewhere.
    if (documentsTab === "tax" || documentsTab === "insurance" || documentsTab === "licensing") {
      redirect(`${def.basePath}/${section}/mine`);
    }
    if (!meta.tabs.some((tab) => tab.id === documentsTab)) notFound();
    return <VendorDocumentsPanel tabId={documentsTab} basePath={def.basePath} />;
  }

  if (kind === "vendor" && section === "profile") {
    if (tabParts?.length) notFound();
    return <VendorSettingsPanel />;
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
