import type { PortalDefinition } from "@/lib/portal-types";

/** Vendor workspace — work orders offered by managers, scheduled visits, and payouts (Phase 3). */
export const vendorPortal: PortalDefinition = {
  kind: "vendor",
  basePath: "/vendor",
  title: "PropLane",
  accent: "blue",
  sections: [
    { section: "dashboard", label: "Dashboard", tabs: [] },
    { section: "work-orders", label: "Services", tabs: [] },
    { section: "calendar", label: "Calendar", tabs: [] },
    { section: "communication", label: "Communication", tabs: [] },
    {
      // Money group (vendor-portal-ia-1007), mirroring the manager's: each its own sidebar row.
      // `payments` is "Incoming payments" (the old Finances > Payments list); like the manager's it
      // declares no registry tabs and owns its Pending / Paid / Overdue segment in the URL
      // (`/vendor/payments/pending`). `/vendor/financials/income` redirects here.
      section: "payments",
      label: "Incoming payments",
      tabs: [],
    },
    // What the vendor spends to do the work (materials, tools, fuel...). Private to the vendor.
    // This month / Last month / Earlier is the URL segment (`/vendor/outgoing/this-month`).
    { section: "outgoing", label: "Outgoing payments", tabs: [] },
    {
      // Overview is the default. `invoices` and `payouts` stay detail-only ids (an invoice / payment
      // record page) and are not tabs; Statements and Tax moved to Documents.
      section: "financials",
      label: "Finances",
      tabs: [
        { id: "overview", label: "Overview" },
        { id: "balance", label: "Balance & payouts" },
        { id: "refunds", label: "Refunds" },
      ],
    },
    {
      // Tax (W-9 / 1099) · Business license · Insurance · Statements · From managers.
      section: "documents",
      label: "Documents",
      tabs: [
        { id: "tax", label: "Tax" },
        { id: "license", label: "Business license" },
        { id: "insurance", label: "Insurance" },
        { id: "statements", label: "Statements" },
        { id: "from-managers", label: "From managers" },
      ],
    },
    // Top bar with sections (VD21, 2026-09-27) — All / Needs reply / Replied,
    // a real routed tab like every other portal list.
    {
      section: "reviews",
      label: "Reviews",
      tabs: [
        { id: "all", label: "All" },
        { id: "needs-reply", label: "Needs reply" },
        { id: "replied", label: "Replied" },
      ],
    },
    { section: "profile", label: "Settings", tabs: [] },
  ],
};

/** Default smoke-test paths for web + native WebView (vendor portal). */
export const VENDOR_PORTAL_SMOKE_PATHS = [
  { label: "Dashboard", path: "/vendor/dashboard" },
  { label: "Services", path: "/vendor/work-orders" },
  { label: "Calendar", path: "/vendor/calendar" },
  { label: "Communication", path: "/vendor/communication/active" },
  { label: "Incoming payments", path: "/vendor/payments/pending" },
  { label: "Outgoing payments", path: "/vendor/outgoing/this-month" },
  { label: "Finances", path: "/vendor/financials/overview" },
  { label: "Balance & payouts", path: "/vendor/financials/balance" },
  { label: "Refunds", path: "/vendor/financials/refunds" },
  { label: "Documents", path: "/vendor/documents/tax" },
  { label: "Reviews", path: "/vendor/reviews" },
  { label: "Settings", path: "/vendor/profile" },
] as const;
