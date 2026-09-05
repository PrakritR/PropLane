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
    { section: "applications", label: "Application", tabs: [] },
    { section: "background-checks", label: "Background check", tabs: [] },
    { section: "leases", label: "Leases", tabs: [] },
    {
      section: "residents",
      label: "Residents",
      tabs: [{ id: "current", label: "Residents" }],
    },
    { section: "inspections", label: "Inspections", tabs: [{ id: "move-in", label: "Move-in" }, { id: "move-out", label: "Move-out" }] },
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
      section: "teams",
      label: "Teams",
      tabs: [
        { id: "managers", label: "Managers" },
        { id: "vendors", label: "Vendors" },
      ],
    },
    { section: "promotion", label: "Promotion", tabs: [] },
    {
      section: "financials",
      label: "Finances",
      tabs: [
        { id: "income", label: "Income" },
        { id: "expenses", label: "Expenses" },
      ],
    },
    {
      section: "documents",
      label: "Documents",
      tabs: [
        { id: "applications", label: "Applications" },
        { id: "leases", label: "Leases" },
        { id: "other", label: "Other" },
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
  { label: "Background checks", path: "/portal/background-checks/pending_review" },
  { label: "Leases", path: "/portal/leases" },
  { label: "Residents", path: "/portal/residents/current" },
  { label: "Inspections", path: "/portal/inspections/move-in" },
  { label: "Payments (incoming)", path: "/portal/payments/incoming/pending" },
  { label: "Payments (outgoing)", path: "/portal/payments/outgoing/pending" },
  { label: "Services", path: "/portal/services/requests" },
  { label: "Tasks", path: "/portal/tasks" },
  { label: "Communication", path: "/portal/communication/active" },
  { label: "Calendar", path: "/portal/calendar" },
  { label: "Bookings", path: "/portal/bookings" },
  { label: "Teams (managers)", path: "/portal/teams/managers" },
  { label: "Teams (vendors)", path: "/portal/teams/vendors" },
  { label: "Promotion", path: "/portal/promotion" },
  { label: "Finances", path: "/portal/financials/income" },
  { label: "Documents", path: "/portal/documents/applications" },
  { label: "Feedback", path: "/portal/bugs-feedback" },
  { label: "App", path: "/portal/app" },
  { label: "Settings", path: "/portal/profile" },
] as const;
