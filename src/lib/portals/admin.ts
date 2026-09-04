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
    { section: "communication", label: "Communication", tabs: [] },
    { section: "axis-users", label: "Accounts", tabs: [] },
    { section: "profile", label: "Settings", tabs: [] },
  ],
};

/** Default smoke-test paths for web + native WebView (admin portal). */
export const ADMIN_PORTAL_SMOKE_PATHS = [
  { label: "Dashboard", path: "/admin/dashboard" },
  { label: "Properties", path: "/admin/properties" },
  { label: "Meetings", path: "/admin/events" },
  { label: "Communication", path: "/admin/communication" },
  { label: "Accounts", path: "/admin/axis-users" },
  { label: "Feedback", path: "/admin/bugs-feedback" },
  { label: "Settings", path: "/admin/profile" },
] as const;
