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
      // ONE nav row, no sub-items (vendor-finances-1008): the page carries Overview · Payouts ·
      // Refunds as tabs in its own header card and owns them as the URL segment
      // (`/vendor/financials/overview|payouts|refunds`), like Incoming / Outgoing payments.
      // `invoices` and `payouts/<id>` stay detail-only record pages; Statements and Tax live in
      // Documents; the old `/financials/balance` is an alias of Payouts.
      section: "financials",
      label: "Finances",
      tabs: [],
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
    // One list of every review, newest first — no tabs, no stat cards (vendor-portal-ia-1007, D4).
    { section: "reviews", label: "Reviews", tabs: [] },
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
  { label: "Payouts", path: "/vendor/financials/payouts" },
  { label: "Refunds", path: "/vendor/financials/refunds" },
  { label: "Documents", path: "/vendor/documents/tax" },
  { label: "Reviews", path: "/vendor/reviews" },
  { label: "Settings", path: "/vendor/profile" },
] as const;
