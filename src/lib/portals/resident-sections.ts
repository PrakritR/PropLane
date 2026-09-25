import type { PortalSection } from "@/lib/portal-types";
import {
  RESIDENT_MOVE_IN_TAB_LABELS,
  RESIDENT_MOVE_IN_TABS,
} from "@/lib/portal-detail-routes";
import {
  RESIDENT_INSPECTION_TAB_LABELS,
  RESIDENT_INSPECTION_TAB_ORDER,
} from "@/lib/resident-inspections-tabs";
import {
  RESIDENT_DOCUMENT_TAB_LABELS,
  RESIDENT_DOCUMENT_TAB_ORDER,
} from "@/lib/resident-documents-tabs";

/** Base path for resident portal — shared by web and Capacitor WebView. */
export const RESIDENT_PORTAL_BASE_PATH = "/resident";

/**
 * Resident sections available when the linked manager is on a free subscription.
 * Communication is always available; single source of truth — also drives manager-access tier gating.
 */
export const RESIDENT_FREE_TIER_SECTION_IDS = [
  "dashboard",
  "tour",
  "lease",
  "applications",
  "payments",
  "move-in",
  "inspections",
  "communication",
  "profile",
] as const;

export type ResidentFreeTierSectionId = (typeof RESIDENT_FREE_TIER_SECTION_IDS)[number];

/**
 * Documents' top destinations (captain, 2026-09-25): To sign / Signed /
 * Archived, replacing the four real category tabs — Application, Lease, Rent
 * receipts, Other documents move into the header's Filter popover as a
 * "Kind" field instead (every one stays reachable — C142 "keep every real
 * tab, invent nothing"). See `src/lib/resident-documents-tabs.ts`.
 */
const DOCUMENTS_TABS = RESIDENT_DOCUMENT_TAB_ORDER.map((id) => ({
  id,
  label: RESIDENT_DOCUMENT_TAB_LABELS[id],
}));

/**
 * Move-in and move-out condition reports are the resident's own section since
 * the portal redesign (they used to be a My home sub-tab, which still redirects
 * here). A resident has no general Tasks list — these two obligations ARE the
 * tasks, and they live on the dashboard as required next steps.
 *
 * Top destinations (captain, 2026-09-25): Upcoming / In progress / Done,
 * derived from each report's own status — Move-in / Move-out moved into the
 * header's Filter popover as a "Type" field. See
 * `src/lib/resident-inspections-tabs.ts`.
 */
const INSPECTIONS_TABS = RESIDENT_INSPECTION_TAB_ORDER.map((id) => ({
  id,
  label: RESIDENT_INSPECTION_TAB_LABELS[id],
}));

const MOVE_IN_TABS = RESIDENT_MOVE_IN_TABS.map((id) => ({
  id,
  label: RESIDENT_MOVE_IN_TAB_LABELS[id],
}));

/**
 * Payments is Charges-only — there is no tab switcher, so its section entries
 * carry `tabs: []`. Pending / Overdue / Paid are in-section *status filters*
 * (`ManagerPortalStatusPills`) inside the panel, not URL-linked tabs. Summary
 * and Statements were removed from the resident portal; every legacy payments
 * sub-path below redirects to the bare Charges view, carrying an optional
 * status pill (see the payments + financials handlers in
 * render-portal-section). Balance / Summary / Statements / Charges land on
 * Charges with no status; Pending / Overdue / Paid preselect the matching pill.
 *
 * Null-prototype on purpose: a plain object literal would resolve inherited
 * `Object.prototype` members, so `/resident/payments/toString` (also
 * `constructor`, `valueOf`, `hasOwnProperty`, `__proto__`) would look like a
 * known legacy tab and soft-redirect instead of 404ing.
 */
export const RESIDENT_PAYMENTS_LEGACY_TABS: Record<string, { status?: string } | undefined> =
  Object.assign(Object.create(null) as Record<string, { status?: string } | undefined>, {
    pending: { status: "pending" },
    overdue: { status: "overdue" },
    paid: { status: "paid" },
    balance: {},
    summary: {},
    statements: {},
    charges: {},
  });

/**
 * Sidebar during application phase: Tour, Application, Dashboard, and
 * Communication, plus Settings pinned last (never stage-locked — see
 * `STAGE_UNLOCKED_SECTIONS` in `resident-portal-nav.ts`). The top-right
 * account menu keeps its own duplicate Settings link too.
 */
export const RESIDENT_APPLICATION_PHASE_PORTAL_SECTIONS: PortalSection[] = [
  { section: "tour", label: "Tour", tabs: [] },
  { section: "applications", label: "Application", tabs: [] },
  { section: "dashboard", label: "Dashboard", tabs: [] },
  { section: "communication", label: "Communication", tabs: [] },
  { section: "profile", label: "Settings", tabs: [] },
];

/**
 * Full resident nav catalog — always registered so web sidebar and mobile More
 * can list every section with stage-based locks.
 */
export const RESIDENT_UNIFIED_PORTAL_SECTIONS: PortalSection[] = [
  { section: "tour", label: "Tour", tabs: [] },
  { section: "applications", label: "Application", tabs: [] },
  { section: "dashboard", label: "Dashboard", tabs: [] },
  { section: "lease", label: "Lease", tabs: [] },
  { section: "services", label: "Services", tabs: [] },
  { section: "inspections", label: "Inspections", tabs: [...INSPECTIONS_TABS] },
  { section: "payments", label: "Payments", tabs: [] },
  { section: "communication", label: "Communication", tabs: [] },
  { section: "move-in", label: "My home", tabs: [...MOVE_IN_TABS] },
  { section: "documents", label: "Documents", tabs: [...DOCUMENTS_TABS] },
  { section: "profile", label: "Settings", tabs: [] },
];

/** Pre-lease workspace: application approved, lease not yet fully signed. */
export const RESIDENT_PRE_LEASE_PORTAL_SECTIONS: PortalSection[] = [
  { section: "dashboard", label: "Dashboard", tabs: [] },
  { section: "tour", label: "Tour", tabs: [] },
  { section: "applications", label: "Application", tabs: [] },
  { section: "lease", label: "Lease", tabs: [] },
  { section: "payments", label: "Payments", tabs: [] },
  { section: "communication", label: "Communication", tabs: [] },
  { section: "documents", label: "Documents", tabs: [...DOCUMENTS_TABS] },
  { section: "profile", label: "Settings", tabs: [] },
];

/** @deprecated Use RESIDENT_APPLICATION_PHASE_PORTAL_SECTIONS */
export const RESIDENT_PRE_APPLICATION_PORTAL_SECTIONS = RESIDENT_APPLICATION_PHASE_PORTAL_SECTIONS;

/** Sections shown before the lease is fully signed (pre-lease resident workspace). */
export const RESIDENT_LIMITED_PORTAL_SECTIONS: PortalSection[] = [
  ...RESIDENT_PRE_LEASE_PORTAL_SECTIONS,
];

/** Full resident workspace after both parties sign the lease. */
export const RESIDENT_APPROVED_PORTAL_SECTIONS: PortalSection[] = [
  { section: "services", label: "Services", tabs: [] },
  { section: "payments", label: "Payments", tabs: [] },
  { section: "dashboard", label: "Dashboard", tabs: [] },
  { section: "tour", label: "Tour", tabs: [] },
  { section: "communication", label: "Communication", tabs: [] },
  { section: "applications", label: "Application", tabs: [] },
  { section: "lease", label: "Lease", tabs: [] },
  { section: "move-in", label: "My home", tabs: [...MOVE_IN_TABS] },
  { section: "inspections", label: "Inspections", tabs: [...INSPECTIONS_TABS] },
  { section: "documents", label: "Documents", tabs: [...DOCUMENTS_TABS] },
  { section: "profile", label: "Settings", tabs: [] },
];

/** Every resident nav section id (union of limited + approved definitions). */
export const RESIDENT_PORTAL_SECTION_IDS = [
  ...new Set([
    ...RESIDENT_UNIFIED_PORTAL_SECTIONS.map((s) => s.section),
    ...RESIDENT_PRE_APPLICATION_PORTAL_SECTIONS.map((s) => s.section),
    ...RESIDENT_PRE_LEASE_PORTAL_SECTIONS.map((s) => s.section),
    ...RESIDENT_LIMITED_PORTAL_SECTIONS.map((s) => s.section),
    ...RESIDENT_APPROVED_PORTAL_SECTIONS.map((s) => s.section),
  ]),
] as const;

/**
 * Resident routes with dedicated handlers in render-portal-section.tsx.
 * Update this list when adding a new section — platform-parity tests enforce it.
 */
export const RESIDENT_RENDERED_SECTION_IDS = [
  "dashboard",
  "tour",
  "lease",
  "payments",
  "move-in",
  "inspections",
  "communication",
  "documents",
  "bugs-feedback",
  "profile",
  "services",
  "work-orders",
  /** Legacy route — applications content lives under Documents */
  "applications",
  /** Legacy route — redirects to payments */
  "financials",
] as const;

/** Default smoke-test paths for web + native WebView (limited resident workspace). */
export const RESIDENT_PORTAL_SMOKE_PATHS = [
  { label: "Dashboard", path: `${RESIDENT_PORTAL_BASE_PATH}/dashboard` },
  { label: "Tour", path: `${RESIDENT_PORTAL_BASE_PATH}/tour` },
  { label: "Applications", path: `${RESIDENT_PORTAL_BASE_PATH}/applications` },
  { label: "Lease", path: `${RESIDENT_PORTAL_BASE_PATH}/lease` },
  { label: "Payments", path: `${RESIDENT_PORTAL_BASE_PATH}/payments` },
  { label: "My home", path: `${RESIDENT_PORTAL_BASE_PATH}/move-in` },
  { label: "Inspections", path: `${RESIDENT_PORTAL_BASE_PATH}/inspections/move-in` },
  { label: "Communication", path: `${RESIDENT_PORTAL_BASE_PATH}/communication/active` },
  { label: "Documents", path: `${RESIDENT_PORTAL_BASE_PATH}/documents/application` },
] as const;

export function residentSectionHref(section: string, tabId?: string): string {
  const base = `${RESIDENT_PORTAL_BASE_PATH}/${section}`;
  return tabId ? `${base}/${tabId}` : base;
}
