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
    { section: "task-list", label: "Tasks", tabs: [] },
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
    { section: "payments", label: "Payments", tabs: [] },
    {
      section: "documents",
      label: "Documents",
      tabs: [
        { id: "tax", label: "Tax & income" },
        { id: "insurance", label: "Insurance" },
        { id: "licensing", label: "Business & licensing" },
        { id: "shared", label: "From managers" },
      ],
    },
    { section: "profile", label: "Settings", tabs: [] },
  ],
};

/** Default smoke-test paths for web + native WebView (vendor portal). */
export const VENDOR_PORTAL_SMOKE_PATHS = [
  { label: "Dashboard", path: "/vendor/dashboard" },
  { label: "Services", path: "/vendor/work-orders" },
  { label: "Tasks", path: "/vendor/task-list/in-progress" },
  { label: "Calendar", path: "/vendor/calendar" },
  { label: "Communication", path: "/vendor/communication/active" },
  { label: "Finances", path: "/vendor/financials/income" },
  { label: "Invoices", path: "/vendor/financials/invoices" },
  { label: "Payments", path: "/vendor/payments" },
  { label: "Documents", path: "/vendor/documents/tax" },
  { label: "Settings", path: "/vendor/profile" },
] as const;
