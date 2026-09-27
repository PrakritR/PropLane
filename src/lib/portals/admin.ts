import type { PortalDefinition } from "@/lib/portal-types";

/** Admin portal navigation (minimal shell; no announcement banner). */
export const adminPortal: PortalDefinition = {
  kind: "admin",
  basePath: "/admin",
  title: "Admin Portal",
  accent: "blue",
  sections: [
    { section: "dashboard", label: "Dashboard", tabs: [] },
    { section: "properties", label: "Properties", tabs: [] },
    { section: "events", label: "Meetings", tabs: [] },
    { section: "bugs-feedback", label: "Feedback", tabs: [] },
    // One inbox, no folder tabs. Unopened / Opened / Sent / Trash described the
    // same rows four times over, and the panel already ignored which one was in
    // the URL. Archived and Scheduled are toggles in the header, where they can
    // carry a count. The legacy `/communication/inbox/<tab>` paths still
    // resolve — a bookmark that lands nowhere is worse than a redundant one.
    // Labeled "Communication" to match the manager portal's own nav (it was
    // "Inbox" here only).
    { section: "communication", label: "Communication", tabs: [] },
    { section: "axis-users", label: "Accounts", tabs: [] },
    { section: "test-accounts", label: "Test accounts", tabs: [] },
    // Billing merged into Accounts (captain: "combine Billing and Accounts") -
    // plan, caps, complimentary status and comms credit all live on the
    // account record page now. No separate nav row; the `/admin/billing` URL
    // still resolves (render-portal-section.tsx), to a one-line redirect card.
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
  { label: "Properties", path: "/admin/properties" },
  { label: "Meetings", path: "/admin/events" },
  { label: "Communication", path: "/admin/communication" },
  { label: "Accounts", path: "/admin/axis-users" },
  // Billing is off the nav (merged into Accounts) but the URL must keep
  // resolving — a bookmark that 404s is worse than a redundant redirect card.
  { label: "Billing", path: "/admin/billing" },
  { label: "Feedback", path: "/admin/bugs-feedback" },
  { label: "Settings", path: "/admin/profile" },
] as const;
