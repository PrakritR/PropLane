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
    { section: "leases", label: "Leases", tabs: [] },
    {
      section: "residents",
      label: "Residents",
      tabs: [{ id: "current", label: "Residents" }],
    },
    {
      // The one Move-in hub: forms residents still owe (Waiting) or filled out (Submitted),
      // across properties, plus the move-in / move-out Inspections. There is no separate
      // Inspections sidebar row; `/portal/inspections/...` redirects to the Inspections tab.
      section: "move-in",
      label: "Move-in",
      tabs: [
        { id: "waiting", label: "Waiting" },
        { id: "submitted", label: "Submitted" },
        { id: "inspections", label: "Inspections" },
      ],
    },
    {
      section: "payments",
      label: "Incoming payments",
      tabs: [],
    },
    {
      section: "services",
      label: "Services",
      // One list. Add-on services and maintenance work orders remain SEPARATE data models — see
      // AGENTS.md — but a manager thinks of them as one queue of work, so they are presented as
      // one. Vendors are their own section, right after: the people the work goes to.
      tabs: [],
    },
    {
      // Who does the work, how to reach them, what they get told. Status pills
      // (active / invited / inactive) live in the page; the URL carries a vendor id
      // for the detail page.
      section: "vendors",
      label: "Vendors",
      tabs: [],
    },
    { section: "outgoing", label: "Outgoing payments", tabs: [] },
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
      // Calendar, Stays and Occupancy use the bookings registry, separate from the schedule grid.
      section: "bookings",
      label: "Bookings",
      tabs: [],
    },
    {
      section: "communication",
      // The section is the whole channel set (in-app, email, text), and the
      // route already says so; the nav now agrees. Paths are unchanged.
      label: "Communication",
      tabs: [],
    },
    // Co-managers live under Settings → Workspaces. `/portal/teams/*` redirects
    // there (render-portal-section); do not re-add a Teams nav section.
    { section: "promotion", label: "Promotion", tabs: [] },
    {
      section: "financials",
      label: "Finances",
      tabs: [
        { id: "overview", label: "Overview" },
        { id: "activity", label: "Activity" },
        { id: "reports", label: "Reports" },
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
  { label: "Properties", path: "/portal/properties/all" },
  { label: "Tours", path: "/portal/tours/pending" },
  { label: "Applications", path: "/portal/applications/pending" },
  { label: "Leases", path: "/portal/leases" },
  { label: "Residents", path: "/portal/residents/current" },
  { label: "Move-in forms", path: "/portal/move-in/waiting" },
  { label: "Inspections", path: "/portal/move-in/inspections" },
  { label: "Incoming payments", path: "/portal/payments/incoming/pending" },
  { label: "Outgoing payments", path: "/portal/outgoing/to-pay" },
  { label: "Services", path: "/portal/services/requests" },
  { label: "Vendors", path: "/portal/vendors" },
  { label: "Tasks", path: "/portal/tasks" },
  { label: "Communication", path: "/portal/communication/active" },
  { label: "Calendar", path: "/portal/calendar" },
  { label: "Bookings", path: "/portal/bookings/calendar" },
  { label: "Workspaces (team)", path: "/portal/profile?tab=workspaces" },
  { label: "Promotion", path: "/portal/promotion" },
  { label: "Finances", path: "/portal/financials/overview" },
  { label: "Documents", path: "/portal/documents/applications" },
  { label: "Feedback", path: "/portal/bugs-feedback" },
  { label: "App", path: "/portal/app" },
  { label: "Settings", path: "/portal/profile" },
] as const;
