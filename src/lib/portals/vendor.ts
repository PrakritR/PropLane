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
      // VD10 — nav label and page title read "Payments"; VD11 folded Income
      // and Invoices into one merged list, so `income`/`invoices` stay as
      // internal tab ids only (routing for invoice record pages still needs
      // "invoices" to validate) rather than two visible destinations.
      section: "financials",
      label: "Payments",
      tabs: [
        { id: "income", label: "Income" },
        { id: "invoices", label: "Invoices" },
      ],
    },
    // No status tabs (VD16, 2026-09-27) — the checklist groups by section
    // (Tax / Business license / Insurance) inline instead.
    { section: "documents", label: "Documents", tabs: [] },
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
  { label: "Payments", path: "/vendor/financials/income" },
  { label: "Invoices", path: "/vendor/financials/invoices" },
  { label: "Documents", path: "/vendor/documents" },
  { label: "Reviews", path: "/vendor/reviews" },
  { label: "Settings", path: "/vendor/profile" },
] as const;
