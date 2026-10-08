import { getOwnerAccessState } from "@/lib/property-owner/access.server";
import { PortalAccessUnavailable } from "@/components/portal/portal-access-unavailable";
import { OWNER_HOME_PATH } from "@/lib/property-owner/sections";
import {
  parseResidentInspectionTypeFilter,
} from "@/lib/resident-inspections-tabs";
import type { InspectionKind } from "@/lib/inspections/model";
import {
  parseResidentDocumentKindFilter,
  RESIDENT_DOCUMENT_KIND_DEFAULT_TAB,
  type ResidentDocumentTab,
} from "@/lib/resident-documents-tabs";
import { isSmsCommUiEnabled } from "@/lib/sms-comm-ui-flag.server";
import { isResidentFormId, parseResidentFormsBucket } from "@/lib/resident-forms-routes";
import { PortalTierPaywall, ResidentTierPaywall } from "@/components/portal/portal-tier-paywall";
import { PortalWorkspaceClient } from "@/components/portal/portal-workspace-client";
import { resolveVendorSettingsTab } from "@/lib/portals/vendor-settings-pages";
import { resolveSettingsRedirectHubTab } from "@/lib/portal-settings-section";
import type { PortalPanels } from "@/lib/render-portal-section/panels";
import type { Crumb } from "@/components/layout/breadcrumbs";
import type { TabItem } from "@/components/ui/tabs";
import type { ReactNode } from "react";
import { getEffectiveSessionForPortal, getEffectiveUserIdForPortal } from "@/lib/auth/effective-session";
import { getServerSessionProfile } from "@/lib/auth/server-profile";
import { managerSectionAllowedForTier, residentSectionAllowedForManagerTier } from "@/lib/manager-access";
import { getManagerPortalNavSubscriptionTier, getManagerSubscriptionTierByManagerId } from "@/lib/manager-access-server";
import { loadResidentPortalAccessState, residentPortalHomePath } from "@/lib/resident-portal-access";
import {
  isResidentPathAllowedForAccess,
} from "@/lib/resident-portal-nav";
import { findSection, getPortalDefinition } from "@/lib/portals";
import { MANAGER_PLAN_PORTAL_URL } from "@/lib/portals/manager-plan-path";
import { RESIDENT_PAYMENTS_LEGACY_TABS } from "@/lib/portals/resident-sections";
import { getProPortalRenderContext } from "@/lib/portals/pro-nav";
import { buildPortalWorkspaceModel } from "@/lib/portal-workspace-model";
import {
  legacyManagerPortalSectionPath,
  isMoveInFormTabSlug,
  isRetiredMoveInFormsTab,
  parseApplicationDetailTab,
  parseFormsBucket,
  parseResidentMoveInTab,
  residentMoveInInspectionsHref,
} from "@/lib/portal-detail-routes";
import type { PortalKind } from "@/lib/portal-types";
import { notFound, redirect } from "next/navigation";
import { DEFERRED_SECTIONS } from "@/lib/portals/nav-locks";
import {
  isTestWorkspaceFeatureEnabled,
  requireTrustedTestWorkspaceOperator,
} from "@/lib/test-workspaces/index.server";

/**
 * Shared routing for every portal catch-all page: redirects, legacy rewrites, guards and
 * the section -> panel mapping. It imports NO panel. Each portal's own module
 * (`src/lib/render-portal-section/{manager,vendor,resident,admin}.tsx`) supplies only the
 * panels that portal renders, so a page's module graph carries its own screens and nothing else.
 */

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
const FINANCIALS_TABS = ["overview", "reports", "income-statement", "profitability", "income", "expenses", "trial-balance", "balance-sheet", "general-ledger", "cash-flow-statement", "payout-history", "trust-account-balance", "security-deposits", "financial-diagnostics", "ap-aging", "bills", "budget-vs-actual", "bank-reconciliation", "owner-statement", "owner-distributions"] as const;

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
  panels: Required<PortalPanels>,
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
  // The Activity tab is gone: it and the legacy income/expenses tabs land on Overview in one hop.
  if (finTab === "activity" || finTab === "income" || finTab === "expenses") {
    redirect(`${basePath}/financials/overview`);
  }
  if (!FINANCIALS_TABS.includes(finTab as (typeof FINANCIALS_TABS)[number])) {
    const docsRedirect = legacyTabMapLookup(LEGACY_FINANCIALS_TO_DOCUMENTS, finTab);
    if (docsRedirect) redirect(`${basePath}/documents/${docsRedirect}`);
    const mapped = legacyTabMapLookup(LEGACY_FINANCIALS_TAB_MAP, finTab);
    if (mapped) redirect(`${basePath}/financials/${mapped}`);
    notFound();
  }
  const ManagerFinancesPanel = await panels.loadManagerFinancesPanel();
  return subscriptionGated(
    <ManagerFinancesPanel tabId={finTab} basePath={basePath} />,
    kind,
    "financials",
    tier,
  );
}

async function renderManagerDocumentsSection(
  panels: Required<PortalPanels>,
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
    const ManagerDocumentsPanel = await panels.loadManagerDocumentsPanel();
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
  const ManagerDocumentsPanel = await panels.loadManagerDocumentsPanel();
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

export async function renderPortalSectionWith(
  portalPanels: PortalPanels,
  kind: PortalKind,
  section: string,
  tabParts?: string[],
  searchParams?: PortalSearchParams,
) {
  // Each portal module supplies only its own panels; a branch below only runs for the portal
  // that supplied the panel it renders (the section branches are keyed on `kind`).
  const panels = portalPanels as Required<PortalPanels>;
  const {
    ManagerInspectionsPage, ResidentInspectionsPage, AdminDashboard, ManagerDashboard, ManagerLeases,
    ManagerPayments, ManagerPromotion, ManagerMobileAppPanel, buildManagerAppQrSvg, ManagerProfile,
    AdminCreateManagerClient, AdminCreateResidentClient, AdminAxisUsersClient, AdminTestWorkspacesClient,
    AdminPropertiesClient, AdminEventsClient, AdminProfileSection, AdminCommunication,
    AdminBugFeedbackClient, AdminHealthClient, ResidentDashboard, ResidentMoveInPanel, ResidentMoveInShell,
    ResidentFormsSection, ResidentCommunication, VendorCommunication, ResidentPaymentsPanel,
    ResidentDocumentsPanel, ResidentApplicationsPanel, ResidentTourPanel, ResidentLeasePanel,
    ResidentProfileSection, PortalBugFeedbackPanel, VendorDashboard, VendorWorkOrdersPanel,
    VendorFinancesPanel, VendorBalancePanel, VendorWithdrawalDetail, VendorRefundsPanel,
    VendorStatementsPanel, VendorTaxPanel, VendorDocumentsPanel, VendorSettingsPanel,
    VendorReviewsPanel, ManagerPortalPageShell, loadManagerAllServicesPanel, loadManagerTaskList,
    loadManagerTours, loadManagerBookings, loadManagerApplications, loadManagerCommunication,
    loadManagerFormsPage, loadManagerProperties, loadManagerResidents, loadManagerVendorsPanel,
    loadManagerOutgoingInvoicesPanel, loadPortalCalendar, loadResidentServicesPanel,
  } = panels;

  // A Property owner (an owner-only account) is sent to their Overview for
  // every manager section — runs before anything else can redirect them into
  // a manager surface. The layout enforces the same rule for the routes that
  // have their own directory; this is the dynamic-section half.
  if (kind === "pro" || kind === "manager") {
    // The session, the acting user id and the plan tier do not depend on each other, so they are
    // read together instead of one after another. Every reader is request-cached: the reads further
    // down reuse these promises, so nothing is fetched twice and nothing new is fetched. A warmed
    // lookup that settles in a redirect is swallowed here and surfaces again at its original read.
    const proRenderContext = kind === "pro" ? getProPortalRenderContext() : null;
    proRenderContext?.catch(() => undefined);
    const [{ user }, managerUserId] = await Promise.all([
      getServerSessionProfile(),
      kind === "manager" ? getEffectiveUserIdForPortal("manager") : Promise.resolve(null),
    ]);
    const managerTierWarm = managerUserId ? getManagerPortalNavSubscriptionTier(managerUserId) : null;
    managerTierWarm?.catch(() => undefined);
    if (user) {
      let ownerOnly: boolean;
      try {
        ownerOnly = (await getOwnerAccessState(user.id)).ownerOnly;
      } catch {
        // Neither shell: a membership we could not read must not decide in
        // favour of the manager surface.
        return <PortalAccessUnavailable />;
      }
      if (ownerOnly) redirect(OWNER_HOME_PATH);
    }
  }

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

  // Resident Inspections moved into My home (C1-R5). `/resident/inspections[/...]` keeps resolving —
  // reminder emails, push deep links and bookmarks all point here. The old bucket URLs
  // (`upcoming|in-progress|done`, optionally `?type=`) land on the merged list, with the type kept.
  // Must run BEFORE findSection (it is no longer a nav section) and before the stage guard.
  if (kind === "resident" && section === "inspections") {
    // Only `move-in` / `move-out` address a page of their own under My home. Anything else the old
    // routes had (`upcoming|in-progress|done`, `reports`, `pending`, ...) is a list address: it lands on
    // the merged list instead of a `/move-in/inspections/<word>` that 404s.
    const firstPart = tabParts?.[0] ?? "";
    const addressesAKind = firstPart === "move-in" || firstPart === "move-out";
    if (!addressesAKind) {
      const type = parseResidentInspectionTypeFilter(firstSearchParam(searchParams, "type"));
      redirect(residentMoveInInspectionsHref(def.basePath, type === "all" ? undefined : type));
    }
    redirect(`${def.basePath}/move-in/inspections/${tabParts!.map(encodeURIComponent).join("/")}`);
  }

  // Resident feedback has no sidebar section of its own — it lives in Settings.
  // This must run BEFORE the findSection lookup below, which would otherwise
  // 404 the route and leave the redirect unreachable.
  if (kind === "resident" && section === "bugs-feedback") {
    redirect(`${def.basePath}/profile`);
  }

  // Teams page retired (PLAN-0923-1934) — co-managers live under Settings →
  // Workspaces. Must run BEFORE findSection: `teams` is no longer in the
  // manager registry. Vendors that used to be a Teams tab still resolve.
  if ((kind === "manager" || kind === "pro") && (section === "teams" || section === "relationships")) {
    if (section === "teams" && tabParts?.[0] === "vendors") {
      const vendorId =
        tabParts.length >= 2 ? `/${encodeURIComponent(decodeURIComponent(tabParts[1]!))}` : "";
      redirect(`${def.basePath}/vendors${vendorId}`);
    }
    redirect(`${def.basePath}/profile?tab=workspaces`);
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

  // Jobs was folded into Services — every /vendor/jobs* URL (any tab, any
  // depth) redirects to Services, where the legacy `pending` id parses to the
  // Open tab, which already lists every invited job (`vendorWorkOrderTab`).
  if (kind === "vendor" && section === "jobs") {
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
    // Bucket + id + the record's own detail tab (PLAN-0921-1029, area 2).
    if (tabParts.length > 3) notFound();
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
    const applicationDetailTab = tabParts.length === 3 ? tabParts[2] : undefined;
    return (
      <ResidentApplicationsPanel
        bucket={applicationBucket}
        basePath={def.basePath}
        applicationId={applicationId}
        applicationDetailTab={applicationDetailTab}
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

  // Vendor Settings lives at section "profile"; `/vendor/settings[/<tab>]` and
  // `?tab=` land there with the resolved tab (unknown/absent tab -> plain).
  if (kind === "vendor" && section === "settings") {
    if (tabParts && tabParts.length > 1) notFound();
    const raw = tabParts?.[0] ?? firstSearchParam(searchParams, "tab");
    const tab = resolveVendorSettingsTab(raw);
    redirect(`${def.basePath}/profile${tab ? `?tab=${encodeURIComponent(tab)}` : ""}`);
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
  if (kind === "vendor" && section === "reviews") {
    // Top bar with sections (VD21, 2026-09-27) — a real routed tab, not a
    // client-only toggle.
    const { VENDOR_REVIEW_STATUS_TABS, isVendorReviewStatusTab } = await import("@/lib/vendor-reviews");
    if (tabParts && tabParts.length > 1) notFound();
    const raw = tabParts?.[0];
    if (!raw) redirect(`${def.basePath}/${section}/${VENDOR_REVIEW_STATUS_TABS[0].id}`);
    if (!isVendorReviewStatusTab(raw)) notFound();
    return <VendorReviewsPanel tabId={raw} basePath={def.basePath} />;
  }
  if (kind === "vendor" && section === "documents") {
    // Status (All / On file / Missing) tabs and the tax/insurance/licensing
    // category tabs are gone (VD16/VD17, 2026-09-27) — the vendor's own
    // checklist is grouped by section inline instead. A stale bookmark or
    // emailed link to any old segment still lands, on the bare section.
    if (tabParts?.length) redirect(`${def.basePath}/${section}`);
    return <VendorDocumentsPanel basePath={def.basePath} />;
  }

  const meta = findSection(def, section);
  if (!meta) notFound();

  let managerOwnerSubscriptionTier: "free" | "paid" | null = null;
  if (kind === "manager" || kind === "pro") {
    if (kind === "pro") {
      const proRender = await getProPortalRenderContext();
      managerOwnerSubscriptionTier = proRender.subscriptionTier;
    } else {
      const uid = await getEffectiveUserIdForPortal("manager");
      if (!uid) redirect("/admin/dashboard");
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
    // A property row's record page is `/admin/properties/<adminRefId>` (C163)
    // — one detail segment, decoded and handed to the client for lookup.
    if ((tabParts?.length ?? 0) > 1) notFound();
    const detailId = tabParts?.length ? decodeURIComponent(tabParts[0]!) : undefined;
    return <AdminPropertiesClient detailId={detailId} />;
  }

  if (kind === "admin" && section === "axis-users") {
    // An account row's record page is `/admin/axis-users/<kind>-<id>` (C165), and
    // each rail section of that record is one more segment: `/<kind>-<id>/billing`.
    if ((tabParts?.length ?? 0) > 2) notFound();
    const detailId = tabParts?.length ? decodeURIComponent(tabParts[0]!) : undefined;
    const detailSection = tabParts && tabParts.length > 1 ? decodeURIComponent(tabParts[1]!) : undefined;
    return <AdminAxisUsersClient detailId={detailId} detailSection={detailSection} />;
  }

  // A branch handling the admin "billing" section used to live here — dead
  // code. That section id was never registered in `adminPortal.sections`
  // (`src/lib/portals/admin.ts`), so `findSection` above always 404s an
  // incoming `/admin/billing` request before reaching a branch here — this
  // one never ran. Removed rather than fixed forward: the
  // captain's call was "combine Billing and Accounts", so `/admin/billing`
  // gets no route at all now. The Plan credit table that briefly lived behind
  // it now mounts on Accounts (`AdminAxisUsersClient`'s "Plan credit" header
  // action + modal); `AdminBillingClient` itself is unused by any route.

  if (kind === "admin" && section === "test-accounts") {
    // A workspace row's record page is `/admin/test-accounts/<workspaceId>` (C168).
    if ((tabParts?.length ?? 0) > 1) notFound();
    if (!isTestWorkspaceFeatureEnabled()) notFound();
    await requireTrustedTestWorkspaceOperator().catch(() => notFound());
    const detailId = tabParts?.length ? decodeURIComponent(tabParts[0]!) : undefined;
    return <AdminTestWorkspacesClient detailId={detailId} />;
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

  if (kind === "admin" && section === "health") {
    if (tabParts?.length) notFound();
    return <AdminHealthClient />;
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

    if (kind === "pro") {
      const legacyPath = legacyManagerPortalSectionPath(section);
      if (legacyPath) {
        redirect(`${def.basePath}/${legacyPath}`);
      }
    }

    // The manager's Forms page (sidebar, TENANCY): every form sent to a resident, Pending (sent) and
    // Completed (submitted). The bucket is the first segment: bare = Pending, `/completed`.
    if (section === "forms") {
      const bucket = tabParts?.[0];
      if ((tabParts?.length ?? 0) > 1 || (bucket !== undefined && !parseFormsBucket(bucket))) notFound();
      const ManagerFormsPage = await loadManagerFormsPage();
      return subscriptionGated(
        <ManagerFormsPage tab={bucket} basePath={def.basePath} />,
        kind,
        "forms",
        managerOwnerSubscriptionTier,
      );
    }

    // Move-in has no page of its own any more: the bare address (and any old form tab slug) goes to
    // Forms. An inspections LIST address goes to the Residents list instead — inspections live on a
    // resident's own record now; a single report (`.../inspections/{move-in|move-out}/{reportId}
    // [/{recordTab}]`) keeps its page.
    if ((kind === "manager" || kind === "pro") && section === "move-in") {
      const moveInTab = tabParts?.[0];
      if (moveInTab === "inspections") {
        const inspectionKind = tabParts?.[1] ?? "move-in";
        if ((inspectionKind !== "move-in" && inspectionKind !== "move-out") || (tabParts?.length ?? 0) > 4) notFound();
        if (!tabParts?.[2]) redirect(`${def.basePath}/residents/current`);
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tabParts[2])) notFound();
        return subscriptionGated(
          <ManagerInspectionsPage
            kind={inspectionKind}
            reportId={tabParts[2]}
            recordTab={tabParts[3]}
            basePath={def.basePath}
          />,
          kind,
          "move-in",
          managerOwnerSubscriptionTier,
        );
      }
      if ((tabParts?.length ?? 0) > 1 || (moveInTab !== undefined && !isMoveInFormTabSlug(moveInTab))) notFound();
      redirect(`${def.basePath}/forms`);
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
      if (residentDetailTabRaw === "inspections" && residentId) {
        // Inspections is a sub-tab of Move in now; an old link opens it there.
        redirect(
          `${def.basePath}/residents/${parsedResidentsTab}/${encodeURIComponent(residentId)}/move-in/inspections`,
        );
      }
      const residentDetailTab = residentDetailTabRaw;
      let residentPaymentId: string | undefined;
      let residentTourBucket: import("@/lib/portal-detail-routes").ManagerTourBucketId | undefined;
      let residentTourId: string | undefined;
      let residentServiceItemId: string | undefined;
      let residentMoveInSubTab: string | undefined;
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
        // The Forms tab carries its bucket (`/forms/completed`) where Move in carries its sub-tab. Forms
        // used to be Move in's first sub-tab: that address lives on as the record's own Forms tab.
        if (residentDetailTab === "move-in" && isRetiredMoveInFormsTab(residentDetailItemId)) {
          redirect(`${def.basePath}/residents/${parsedResidentsTab}/${encodeURIComponent(residentId!)}/forms`);
        }
        residentMoveInSubTab =
          residentDetailTab === "move-in" || residentDetailTab === "forms" ? residentDetailItemId : undefined;
        if (residentDetailTab === "forms" && residentDetailItemId !== undefined && !parseFormsBucket(residentDetailItemId)) notFound();
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
          moveInTab={residentMoveInSubTab}
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
      const WO_BUCKETS = ["open", "assigned", "scheduled", "completed"] as const;

      if (!tabParts?.length) {
        redirect(`${def.basePath}/services/work-orders/open`);
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
        // An old tab id (`done`, `pending`, `active`, ...) lands on its stage, keeping any record
        // path after it; a link never falls home.
        const { parseServiceStage } = await import("@/lib/service-stage-ids");
        const workOrderBucket = WO_BUCKETS.includes(bucketRaw as typeof WO_BUCKETS[number])
          ? (bucketRaw as typeof WO_BUCKETS[number])
          : parseServiceStage(bucketRaw);
        if (bucketRaw !== workOrderBucket) {
          const rest = tabParts.slice(2).map((part) => `/${encodeURIComponent(decodeURIComponent(part))}`).join("");
          redirect(`${def.basePath}/services/work-orders/${workOrderBucket}${rest}`);
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
      const { parseServiceDetailTab, DEFAULT_SERVICE_DETAIL_TAB } = await import("@/lib/portal-detail-routes");
      const serviceDetailTabRaw = tabParts.length >= 4 ? tabParts[3]! : undefined;
      const serviceDetailTab =
        serviceRequestId || workOrderId ? parseServiceDetailTab(serviceDetailTabRaw) : undefined;
      if ((serviceRequestId || workOrderId) && serviceDetailTabRaw && serviceDetailTab !== serviceDetailTabRaw) {
        // Old Overview / Photos / Payments links land on Service / Incoming payments; the default
        // tab is the bare record URL, same as workOrderDetailHref builds it.
        const recordPath = `${def.basePath}/services/${servicesTab}/${tabParts[1]}/${encodeURIComponent(tabParts[2]!)}`;
        redirect(serviceDetailTab === DEFAULT_SERVICE_DETAIL_TAB ? recordPath : `${recordPath}/${serviceDetailTab}`);
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
      const { MANAGER_TASK_LIST_TABS, parseManagerTaskListTab, legacyTaskListSectionRedirectPath } = await import(
        "@/lib/portal-detail-routes"
      );
      // Old slugs (in-progress, overdue, late, done...) land on their stage tab, tail preserved.
      if (taskTab && !(MANAGER_TASK_LIST_TABS as readonly string[]).includes(taskTab)) {
        redirect(legacyTaskListSectionRedirectPath(def.basePath, tabParts));
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

    if (section === "outgoing") {
      if (!tabParts?.length) redirect(`${def.basePath}/outgoing/to-pay`);
      const outgoingTab = tabParts[0]!;
      // One payment is a record page: outgoing/payment/<id>[/communication] (Payment · Communication).
      if (outgoingTab === "payment") {
        const paymentSection = tabParts[2];
        if (tabParts.length < 2 || tabParts.length > 3 || (paymentSection !== undefined && paymentSection !== "communication")) notFound();
        const ManagerOutgoingInvoicesPanel = await loadManagerOutgoingInvoicesPanel();
        return subscriptionGated(
          <ManagerOutgoingInvoicesPanel
            tabId="to-pay"
            basePath={def.basePath}
            paymentId={decodeURIComponent(tabParts[1]!)}
            paymentTab={paymentSection === "communication" ? "communication" : "overview"}
          />,
          kind, "outgoing", managerOwnerSubscriptionTier,
        );
      }
      if (tabParts.length !== 1 || !["to-pay", "scheduled", "paid"].includes(outgoingTab)) notFound();
      const ManagerOutgoingInvoicesPanel = await loadManagerOutgoingInvoicesPanel();
      return subscriptionGated(
        <ManagerOutgoingInvoicesPanel tabId={outgoingTab} basePath={def.basePath} />,
        kind, "outgoing", managerOwnerSubscriptionTier,
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

      // Old list bookmarks open the new Operations destination. Historical
      // payout record URLs remain readable by the existing record renderer.
      if (tabParts[0] === "outgoing" && tabParts.length <= 2) {
        redirect(`${def.basePath}/outgoing/${tabParts[1] === "paid" ? "paid" : "to-pay"}`);
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
      panels,
      section,
      tabParts,
      def.basePath,
      kind,
      managerOwnerSubscriptionTier,
    );
    if (financesView) return financesView;
    const documentsView = await renderManagerDocumentsSection(
      panels,
      section,
      tabParts,
      def.basePath,
      kind,
      managerOwnerSubscriptionTier,
    );
    if (documentsView) return documentsView;

    if (section === "leases") {
      if (!tabParts?.length) {
        redirect(`${def.basePath}/leases/draft`);
      }
      if (tabParts.length > 3) notFound();
      const tabRaw = tabParts[0]!;
      // Resident signature · Manager signature · Signed are the words on the list; they resolve to the route ids behind them.
      const { parseLeasePipelineTab } = await import("@/lib/portal-detail-routes");
      const leaseTab = parseLeasePipelineTab(tabRaw);
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
      if (!tabParts?.length) {
        redirect(`${def.basePath}/applications/pending`);
      }
      if (tabParts.length > 3) notFound();
      const tabRaw = tabParts[0]!;
      if (tabRaw === "screenings") {
        const legacyId = tabParts.length >= 2 ? `/${encodeURIComponent(decodeURIComponent(tabParts[1]!))}` : "";
        redirect(`${def.basePath}/applications/approved${legacyId}`);
      }
      // Pending · Approved · Declined; an old /incomplete or /declined link lands on its real bucket.
      const { parseApplicationListTab } = await import("@/lib/portal-detail-routes");
      const applicationTab = parseApplicationListTab(tabRaw);
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
      // Forms is its own property tab now: the old `/move-in/forms` path and `?tab=forms` land on it.
      if (
        propertyKey &&
        propertyDetailTabRaw === "move-in" &&
        (tabParts[3] === "forms" || firstSearchParam(searchParams, "tab") === "forms")
      ) {
        redirect(`${def.basePath}/properties/${stage}/${encodeURIComponent(propertyKey)}/forms`);
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
      const {
        MANAGER_BOOKING_BUCKETS,
        LEGACY_MANAGER_BOOKING_BUCKET_REDIRECTS,
        parseManagerBookingBucket,
        isBookingDayKeySegment,
      } = await import(
        "@/lib/portal-detail-routes"
      );
      if (!tabParts?.length) {
        redirect(`${def.basePath}/bookings/calendar`);
      }
      const segmentRaw = tabParts[0]!;
      const ManagerBookings = await loadManagerBookings();
      // The day popup (`/bookings/2026-09-01`) overlays the calendar tab —
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
      // Stays and Occupancy are not tabs: old links redirect to Calendar.
      const legacyBucket = LEGACY_MANAGER_BOOKING_BUCKET_REDIRECTS[segmentRaw];
      if (legacyBucket && tabParts.length === 1) {
        redirect(`${def.basePath}/bookings/${legacyBucket}`);
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
      // N068: a real QR code fills the desktop-only blank space next to the
      // phone-dock layout with a fast desktop-to-phone handoff, generated
      // server-side from the same canonical download URL the App Store badge
      // uses (same pattern as the public /app page and the house print sheets).
      const qrCodeSvg = await buildManagerAppQrSvg();
      return subscriptionGated(<ManagerMobileAppPanel qrCodeSvg={qrCodeSvg} />, kind, "app", managerOwnerSubscriptionTier);
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
    // Bucket + id + the record's own detail tab (PLAN-0921-1029, area 2).
    if (tabParts.length > 3) notFound();
    const tabRaw = tabParts[0]!;
    const paymentBucket = PAY_BUCKETS.includes(tabRaw as (typeof PAY_BUCKETS)[number])
      ? (tabRaw as (typeof PAY_BUCKETS)[number])
      : "pending";
    if (tabRaw !== paymentBucket) {
      redirect(`${def.basePath}/payments/${paymentBucket}`);
    }
    const chargeId = tabParts.length >= 2 ? decodeURIComponent(tabParts[1]!) : undefined;
    const chargeDetailTab = tabParts.length === 3 ? tabParts[2] : undefined;
    return (
      <ResidentPaymentsPanel
        bucket={paymentBucket}
        basePath={def.basePath}
        chargeId={chargeId}
        chargeDetailTab={chargeDetailTab}
      />
    );
  }

  if (kind === "resident" && section === "documents") {
    const allowedTabs = meta.tabs.map((t) => t.id); // bucket ids: to-sign, signed, archived
    if (!tabParts?.length) {
      redirect(`${def.basePath}/${section}/${allowedTabs[0] ?? "to-sign"}`);
    }
    if (tabParts.length > 2) notFound();
    const seg = tabParts[0]!;
    // "Shared with you" was merged into "Other documents" long ago — keep old deep links alive.
    if (seg === "shared") redirect(`${def.basePath}/${section}/archived?kind=other`);

    // Legacy category LIST url (no detail id) — captain, 2026-09-25: the top
    // destinations are now To sign / Signed / Archived, and Application /
    // Lease / Rent receipts / Other documents moved into the Filter
    // popover's "Kind" field. Land on that kind's default bucket with the
    // kind preselected rather than 404ing.
    const legacyKind = parseResidentDocumentKindFilter(seg);
    if (legacyKind && !tabParts[1]) {
      redirect(`${def.basePath}/${section}/${RESIDENT_DOCUMENT_KIND_DEFAULT_TAB[legacyKind]}?kind=${legacyKind}`);
    }

    // Detail via the legacy kind segment (`/documents/{kind}/{id}`) is
    // unchanged — a document always opens under its own real kind, whichever
    // bucket/kind filter the resident found it from.
    if (legacyKind === "application" || legacyKind === "lease" || legacyKind === "receipts") {
      const detailId = decodeURIComponent(tabParts[1]!);
      const tierGate = residentManagerTierGate("documents", residentManagerTier, meta.label);
      if (tierGate) return tierGate;
      return (
        <ResidentDocumentsPanel
          tabId={legacyKind}
          basePath={def.basePath}
          applicationId={legacyKind === "application" ? detailId : undefined}
          leaseId={legacyKind === "lease" ? detailId : undefined}
          receiptId={legacyKind === "receipts" ? detailId : undefined}
        />
      );
    }
    // "Other documents" never had a detail-id route.
    if (legacyKind === "other") notFound();

    // New bucket LIST route: `/documents/{to-sign|signed|archived}`.
    if (!allowedTabs.includes(seg)) notFound();
    const tierGate = residentManagerTierGate("documents", residentManagerTier, meta.label);
    if (tierGate) return tierGate;
    return (
      <ResidentDocumentsPanel
        tabId={seg}
        basePath={def.basePath}
        bucket={seg as ResidentDocumentTab}
        kindFilter={parseResidentDocumentKindFilter(firstSearchParam(searchParams, "kind"))}
      />
    );
  }

  if (kind === "resident" && section === "lease") {
    const LEASE_BUCKETS = ["pending", "signed"] as const;
    if (!tabParts?.length) {
      redirect(`${def.basePath}/lease/pending`);
    }
    // Bucket + id + the record's own detail tab (PLAN-0921-1029, area 2).
    if (tabParts.length > 3) notFound();
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
    const leaseDetailTab = tabParts.length === 3 ? tabParts[2] : undefined;
    return (
      <ResidentLeasePanel
        basePath={def.basePath}
        bucket={leaseBucket}
        leaseDetailId={leaseDetailId}
        leaseDetailTab={leaseDetailTab}
      />
    );
  }

  // Resident Forms: Pending · Completed, and one form at `/forms/<id>`. Unlocked from an approved
  // application on; before approval the stage guard allows ONLY a form's own `/forms/<id>` address, so
  // the list and `/forms/completed` are refused until then.
  if (kind === "resident" && section === "forms") {
    if ((tabParts?.length ?? 0) > 1) notFound();
    const seg = tabParts?.[0];
    if (seg !== undefined && !parseResidentFormsBucket(seg) && !isResidentFormId(seg)) notFound();
    return (
      <ManagerPortalPageShell title="Forms" hideTitleOnMobileNav compactFilterRow>
        <ResidentFormsSection
          basePath={def.basePath}
          bucket={parseResidentFormsBucket(seg) ?? "pending"}
          formId={isResidentFormId(seg) ? seg : undefined}
        />
      </ManagerPortalPageShell>
    );
  }

  if (kind === "resident" && section === "move-in") {
    const moveInEmail = residentCtx?.profile?.email ?? residentCtx?.user?.email ?? null;
    const allowedTabs = meta.tabs.map((t) => t.id);
    // Forms used to be My home's first tab; that address (and an old emailed link to it) is the Forms section now.
    if (isRetiredMoveInFormsTab(tabParts?.[0])) redirect(`${def.basePath}/forms`);
    // My home is the house's details: it opens with a signed lease (or an attested tenancy) and never earlier.
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
    const moveInTab = tabParts[0]!;
    // An unsubmitted form that blocks "Move-in details" is decided here, on the server, from the forms
    // table: the details tab renders its lock and no house detail is loaded into the page at all. A
    // read that FAILED holds the same lock without naming a form, the way the approve and lease
    // refusals do.
    const formsLock = residentAccess?.blockingFormsPending?.moveInDetails
      ? {
          formId: residentAccess.blockingFormsPending.formIds?.moveInDetails ?? null,
          readFailed: residentAccess.blockingFormsPending.readFailed ?? false,
        }
      : undefined;
    // My home › Inspections: `/inspections` (all), `/inspections/{move-in|move-out}` (one type) and
    // `/inspections/{move-in|move-out}/{reportId}` (one filed report, on its own page).
    if (moveInTab === "inspections") {
      const [, inspectionKind, reportId, ...extra] = tabParts;
      if (inspectionKind !== undefined && inspectionKind !== "move-in" && inspectionKind !== "move-out") notFound();
      if (extra.length > 0) notFound();
      if (reportId !== undefined) {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(reportId)) notFound();
        return <ResidentInspectionsPage kind={inspectionKind as InspectionKind} reportId={reportId} basePath={def.basePath} />;
      }
      return (
        <ResidentMoveInPanel
          residentEmail={moveInEmail}
          basePath={def.basePath}
          tabId="inspections"
          tabs={meta.tabs}
          leaseSigned={residentAccess?.leaseSigned ?? false}
          inspectionsTypeFilter={inspectionKind ? parseResidentInspectionTypeFilter(inspectionKind) : undefined}
        />
      );
    }
    if (tabParts.length > 1) notFound();
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
        leaseSigned={residentAccess?.leaseSigned ?? false}
        formsLock={formsLock}
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
    // Find work: the fifth Services tab, published work from any manager (vendor-work-share-1006).
    if (raw === "find-work") {
      if (tabParts.length > 1) notFound();
      return <VendorWorkOrdersPanel tabId="find-work" />;
    }
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
    const { vendorCalendarHref } = await import("@/lib/portal-detail-routes");
    // One view: every retired /calendar/<tab> (all, services, availability, day, week, month, list,
    // tasks, tours) lands on the bare route instead of 404ing.
    if (tabParts?.length) redirect(vendorCalendarHref(def.basePath));
    const PortalCalendar = await loadPortalCalendar();
    return <PortalCalendar portal="vendor" />;
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
      // Finances opens on Balance & payouts; `income` (Payments) is still its own tab.
      redirect(`${def.basePath}/financials/balance`);
    }
    const finTab = tabParts[0]!;
    // "payouts" is a detail-only tab id: VD10/VD11 merged the visible Payouts
    // door into Payments (`income`), so it never appears in `meta.tabs`, but a
    // payout's own record page (`/financials/payouts/<id>[/<tab>]`, linked
    // from the merged list and from a paid invoice with a matching
    // `vendor_payouts` row) must still resolve rather than 404 on a tab the
    // nav no longer shows.
    // `invoices` joined it when Finances became five tabs: an invoice's own
    // record page lives under it, the bare id is a door to Payments.
    const DETAIL_ONLY_FINANCIALS_TABS = ["payouts", "invoices"] as const;
    if (
      !meta.tabs.some((tab) => tab.id === finTab) &&
      !(DETAIL_ONLY_FINANCIALS_TABS as readonly string[]).includes(finTab)
    ) {
      notFound();
    }

    if (finTab === "invoices" || finTab === "payouts") {
      // A record under this tab: /financials/invoices|payouts/<id>/<tab>
      // (PLAN-0920-1058, area 1c).
      if (tabParts.length > 3) notFound();
      if (tabParts.length === 1) {
        // The bare `payouts` id is a door to Balance & payouts (it used to open
        // Settings → Payouts, which now keeps only bank accounts + schedule). A
        // payment's own record below still renders here.
        if (finTab === "payouts") {
          redirect(`${def.basePath}/financials/balance`);
        }
        // VD11 — Income and Invoices merged into one Payments list at the
        // `income` tabId; the bare Invoices tab is a door to it, same shape
        // as the Payouts redirect above. An invoice record below still
        // renders here.
        redirect(`${def.basePath}/financials/income`);
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

    // A withdrawal's own page: /financials/balance/<payoutId>.
    if (finTab === "balance" && tabParts.length === 2 && tabParts[1] !== "pending") {
      return <VendorWithdrawalDetail basePath={def.basePath} withdrawalId={decodeURIComponent(tabParts[1]!)} />;
    }
    if (tabParts.length > 1) {
      if (tabParts.length === 2 && tabParts[1] === "pending") {
        redirect(`${def.basePath}/financials/${tabParts[0]}`);
      }
      notFound();
    }
    if (finTab === "balance") return <VendorBalancePanel basePath={def.basePath} />;
    if (finTab === "refunds") return <VendorRefundsPanel basePath={def.basePath} />;
    if (finTab === "statements") return <VendorStatementsPanel basePath={def.basePath} />;
    if (finTab === "tax") return <VendorTaxPanel basePath={def.basePath} />;
    return <VendorFinancesPanel tabId={finTab} basePath={def.basePath} />;
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
