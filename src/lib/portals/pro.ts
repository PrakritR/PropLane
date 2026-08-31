import type { PortalDefinition } from "@/lib/portal-types";

/** Unified property workspace — managers, owners, and paid workspace users share one portal. */
export const proPortal: PortalDefinition = {
  kind: "pro",
  basePath: "/portal",
  title: "PropLane",
  accent: "blue",
  sections: [
    { section: "dashboard", label: "Dashboard", tabs: [] },
    { section: "properties", label: "Properties", tabs: [] },
    { section: "tours", label: "Tours", tabs: [] },
    { section: "applications", label: "Applications", tabs: [] },
    { section: "leases", label: "Leases", tabs: [] },
    {
      section: "residents",
      label: "Residents",
      tabs: [{ id: "current", label: "Residents" }],
    },
    {
      section: "payments",
      label: "Payments",
      tabs: [
        { id: "incoming", label: "Incoming" },
        { id: "outgoing", label: "Outgoing" },
      ],
    },
    {
      section: "services",
      label: "Services",
      // One list. Add-on services and maintenance work orders remain SEPARATE data models — see
      // AGENTS.md — but a manager thinks of them as one queue of work, so they are presented as
      // one. Vendors moved to Team, where the people are.
      tabs: [],
    },
    {
      section: "tasks",
      label: "Tasks",
      tabs: [
        { id: "in-progress", label: "In progress" },
        { id: "overdue", label: "Overdue" },
        { id: "completed", label: "Completed" },
      ],
    },
    {
      // Availability + committed tours, service visits, and tasks on one grid.
      section: "calendar",
      label: "Calendar",
      tabs: [],
    },
    {
      // Channel + PropLane stays across the portfolio — separate from the schedule grid.
      section: "bookings",
      label: "Bookings",
      tabs: [],
    },
    {
      section: "communication",
      label: "Communication",
      tabs: [],
    },
    {
      section: "relationships",
      label: "Managers",
      tabs: [],
    },
    {
      // Its own sidebar entry beside Managers under the Team heading — the same shape Tenancy
      // uses for Residents / Payments / Services, rather than a tab strip inside one page.
      section: "vendors",
      label: "Vendors",
      tabs: [],
    },
    { section: "promotion", label: "Promotion", tabs: [] },
    {
      section: "financials",
      label: "Finances",
      tabs: [
        { id: "income", label: "Income" },
        { id: "expenses", label: "Expenses" },
        { id: "trial-balance", label: "Trial balance" },
        { id: "balance-sheet", label: "Balance sheet" },
        { id: "general-ledger", label: "General ledger" },
        { id: "cash-flow-statement", label: "Cash flow" },
        { id: "payout-history", label: "Payout history" },
        { id: "trust-account-balance", label: "Trust account" },
        { id: "security-deposits", label: "Deposits" },
        { id: "financial-diagnostics", label: "Diagnostics" },
        { id: "ap-aging", label: "AP aging" },
        { id: "bills", label: "Bills" },
        { id: "budget-vs-actual", label: "Budget" },
        { id: "bank-reconciliation", label: "Bank rec" },
        { id: "owner-statement", label: "Owner statement" },
        { id: "owner-distributions", label: "Distributions" },
      ],
    },
    {
      section: "documents",
      label: "Documents",
      tabs: [
        { id: "library", label: "Library" },
        { id: "templates", label: "Templates" },
        { id: "applications", label: "Applications" },
        { id: "leases", label: "Leases" },
        { id: "income-documents", label: "Income documents" },
        { id: "expense-documents", label: "Expense documents" },
        { id: "occupancy", label: "Occupancy" },
        { id: "1099", label: "1099 forms" },
        { id: "tax-summary", label: "Tax summary" },
      ],
    },
    { section: "bugs-feedback", label: "Feedback", tabs: [] },
    { section: "app", label: "App", tabs: [] },
    { section: "profile", label: "Settings", tabs: [] },
  ],
};

/** Default smoke-test paths for web + native WebView (manager/pro portal). */
export const MANAGER_PORTAL_SMOKE_PATHS = [
  { label: "Dashboard", path: "/portal/dashboard" },
  { label: "Properties", path: "/portal/properties/listed" },
  { label: "Tours", path: "/portal/tours/pending" },
  { label: "Applications", path: "/portal/applications/pending" },
  { label: "Leases", path: "/portal/leases" },
  { label: "Residents", path: "/portal/residents/current" },
  { label: "Payments (incoming)", path: "/portal/payments/incoming/pending" },
  { label: "Payments (outgoing)", path: "/portal/payments/outgoing/pending" },
  { label: "Services", path: "/portal/services/requests" },
  { label: "Tasks", path: "/portal/tasks" },
  { label: "Communication", path: "/portal/communication/active" },
  { label: "Calendar", path: "/portal/calendar" },
  { label: "Bookings", path: "/portal/bookings" },
  { label: "Managers", path: "/portal/relationships" },
  { label: "Vendors", path: "/portal/vendors" },
  { label: "Promotion", path: "/portal/promotion" },
  { label: "Finances", path: "/portal/financials/income" },
  { label: "Documents", path: "/portal/documents/library" },
  { label: "Feedback", path: "/portal/bugs-feedback" },
  { label: "App", path: "/portal/app" },
  { label: "Settings", path: "/portal/profile" },
] as const;
