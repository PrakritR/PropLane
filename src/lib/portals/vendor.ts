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
      // Finances (vendor-banking-1006): one section, five routed tabs. `income`
      // keeps its id so every old `/vendor/financials/income` link still lands
      // on the Payments list (VD10/VD11). `invoices` and `payouts` are detail-only
      // ids (an invoice / payment record page) — see render-portal-section.tsx.
      section: "financials",
      label: "Finances",
      tabs: [
        { id: "balance", label: "Balance & payouts" },
        { id: "income", label: "Payments" },
        { id: "refunds", label: "Refunds" },
        { id: "statements", label: "Statements" },
        { id: "tax", label: "Tax info" },
      ],
    },
    // No status tabs (VD16, 2026-09-27) — the checklist groups by section
    // (Tax / Business license / Insurance) inline instead.
    { section: "documents", label: "Documents", tabs: [] },
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
  { label: "Balance & payouts", path: "/vendor/financials/balance" },
  { label: "Payments", path: "/vendor/financials/income" },
  { label: "Refunds", path: "/vendor/financials/refunds" },
  { label: "Statements", path: "/vendor/financials/statements" },
  { label: "Tax info", path: "/vendor/financials/tax" },
  { label: "Documents", path: "/vendor/documents" },
  { label: "Reviews", path: "/vendor/reviews" },
  { label: "Settings", path: "/vendor/profile" },
] as const;
