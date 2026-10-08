import type { PortalDefinition } from "@/lib/portal-types";

/** Admin portal navigation (minimal shell; no announcement banner). */
export const adminPortal: PortalDefinition = {
  kind: "admin",
  basePath: "/admin",
  title: "Admin Portal",
  accent: "blue",
  // Order is the sidebar's: Dashboard, Communication · Accounts · Portfolio · Support
  // (`ADMIN_GROUPS` in nav-groups.ts buckets these; a test pins every id exactly once).
  sections: [
    { section: "dashboard", label: "Dashboard", tabs: [] },
    // One inbox, no folder tabs. Unopened / Opened / Sent / Trash described the
    // same rows four times over, and the panel already ignored which one was in
    // the URL. Archived and Scheduled are toggles in the header, where they can
    // carry a count. The legacy `/communication/inbox/<tab>` paths still
    // resolve - a bookmark that lands nowhere is worse than a redundant one.
    // Labeled "Communication" to match the manager portal's own nav (it was
    // "Inbox" here only).
    { section: "communication", label: "Communication", tabs: [] },
    { section: "axis-users", label: "Accounts", tabs: [] },
    { section: "test-accounts", label: "Test accounts", tabs: [] },
    { section: "properties", label: "Properties", tabs: [] },
    { section: "bugs-feedback", label: "Feedback", tabs: [] },
    { section: "events", label: "Meetings", tabs: [] },
    // Failed deliveries and stuck work, grouped by kind (GET /api/admin/health).
    { section: "health", label: "Health", tabs: [] },
    // PropLane's own social content pipeline (queue, calendar, post, accounts, analytics).
    { section: "growth", label: "Growth", tabs: [] },
    // Billing merged into Accounts (captain: "combine Billing and Accounts") -
    // plan, caps, complimentary status and comms credit all live on the
    // account record page now. No separate nav row, and no `/admin/billing`
    // route either: `"billing"` was never a registered section here, so that
    // URL 404s (`findSection` in render-portal-section.tsx). The one thing
    // that used to live behind it - the global per-plan "Plan credit" table
    // (`PlanCreditRulesSection`) - now mounts on Accounts (`axis-users`)
    // behind a header icon action instead.
    { section: "profile", label: "Settings", tabs: [] },
  ],
};

/** Keep the operator-only entry out of every other admin's navigation. */
export function adminPortalForTestWorkspaceOperator(allowed: boolean): PortalDefinition {
  if (allowed) return adminPortal;
  return {
    ...adminPortal,
    sections: adminPortal.sections.filter((section) => section.section !== "test-accounts"),
  };
}

/** Default smoke-test paths for web + native WebView (admin portal). */
export const ADMIN_PORTAL_SMOKE_PATHS = [
  { label: "Dashboard", path: "/admin/dashboard" },
  { label: "Communication", path: "/admin/communication" },
  { label: "Accounts", path: "/admin/axis-users" },
  { label: "Properties", path: "/admin/properties" },
  { label: "Feedback", path: "/admin/bugs-feedback" },
  { label: "Meetings", path: "/admin/events" },
  { label: "Health", path: "/admin/health" },
  { label: "Growth", path: "/admin/growth" },
  { label: "Settings", path: "/admin/profile" },
] as const;
