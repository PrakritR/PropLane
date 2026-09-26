import type { PortalDefinition } from "@/lib/portal-types";

/** Vendor workspace — work orders offered by managers, scheduled visits, and payouts (Phase 3). */
export const vendorPortal: PortalDefinition = {
  kind: "vendor",
  basePath: "/vendor",
  title: "PropLane",
  accent: "blue",
  sections: [
    { section: "dashboard", label: "Dashboard", tabs: [] },
    // C152/C153: Invited surfaces jobs this vendor has been asked to bid on
    // (today's single-vendor biddingOpen flag); Open is a placeholder — a
    // genuine cross-workspace marketplace browse has no data model yet
    // (docs/agents/vendor-portal.md Phase 2). Purely additive to Services,
    // which keeps its own assigned-job flow unchanged.
    {
      section: "jobs",
      label: "Jobs",
      tabs: [
        { id: "invited", label: "Invited" },
        { id: "open", label: "Open" },
      ],
    },
    { section: "work-orders", label: "Services", tabs: [] },
    { section: "calendar", label: "Calendar", tabs: [] },
    { section: "communication", label: "Communication", tabs: [] },
    {
      section: "financials",
      label: "Finances",
      tabs: [
        { id: "income", label: "Income" },
        { id: "invoices", label: "Invoices" },
      ],
    },
    {
      section: "documents",
      label: "Documents",
      // Source is a filter in one list; the document KIND stays structural for
      // uploads while its category remains a row label.
      tabs: [{ id: "all", label: "All" }],
    },
    { section: "reviews", label: "Reviews", tabs: [] },
    { section: "profile", label: "Settings", tabs: [] },
  ],
};

/** Default smoke-test paths for web + native WebView (vendor portal). */
export const VENDOR_PORTAL_SMOKE_PATHS = [
  { label: "Dashboard", path: "/vendor/dashboard" },
  { label: "Jobs", path: "/vendor/jobs/invited" },
  { label: "Services", path: "/vendor/work-orders" },
  { label: "Calendar", path: "/vendor/calendar" },
  { label: "Communication", path: "/vendor/communication/active" },
  { label: "Finances", path: "/vendor/financials/income" },
  { label: "Invoices", path: "/vendor/financials/invoices" },
  { label: "Documents", path: "/vendor/documents/all" },
  { label: "Reviews", path: "/vendor/reviews" },
  { label: "Settings", path: "/vendor/profile" },
] as const;
