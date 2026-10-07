// @vitest-environment jsdom
//
// The manager Dashboard draws its customizable sections in the order of
// MANAGER_DASHBOARD_SECTIONS (cash flow, drafts, then the groups inside
// "Everything open"), and a section the manager hides leaves that sequence
// without reordering the rest. Rendered with the same deterministic scenario
// as manager-dashboard-banners.test.tsx.
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
// Dashboard still uses useRouter for explicit clicks; this suite
// renders ManagerDashboard without an App Router tree.
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
  }),
  usePathname: () => "/portal/dashboard",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/manager-first-listing-onboarding", () => ({
  firstListingDashboardRedirectStorageKey: (id: string) => `test-redirect:${id}`,
  managerNeedsFirstListingOnboarding: () => false,
  managerPortfolioNeedsFirstListingSeed: () => false,
  readFirstListingPortfolioSnapshot: () => ({ listingSlots: 1, drafts: 0, unlisted: 0 }),
  shouldSkipFirstListingOnboarding: () => true,
}));

// ── Inject a deterministic scenario through the data layer the dashboard reads.
// One overdue charge + one on-time pending charge + apps/leases/inbox items, so
// the banner block is populated and the payments table has an "Overdue" row.
const CHARGES = [
  {
    id: "chg-overdue",
    status: "pending",
    createdAt: "2026-05-01T00:00:00.000Z",
    residentName: "Dana Ramirez",
    residentEmail: "dana@example.com",
    title: "May rent",
    balanceLabel: "$1,250.00",
    __overdue: true,
  },
  {
    id: "chg-pending",
    status: "pending",
    createdAt: "2026-06-20T00:00:00.000Z",
    residentName: "Sam Lee",
    residentEmail: "sam@example.com",
    title: "Parking fee",
    balanceLabel: "$75.00",
    __overdue: false,
  },
];

vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => ({ userId: "mgr-1", email: "mgr@example.com", ready: true }),
}));

vi.mock("@/lib/household-charges", () => ({
  HOUSEHOLD_CHARGES_EVENT: "household-charges-changed",
  syncHouseholdChargesFromServer: () => Promise.resolve(),
  readChargesForManager: () => CHARGES,
  isHouseholdChargeOverdue: (c: { __overdue?: boolean }) => Boolean(c.__overdue),
  // The dashboard now buckets through the same helper the Payments tabs use, so
  // the two surfaces can't disagree (F-PAY-1). Mirror the scenario's __overdue flag.
  householdChargeManagerBucket: (c: { status?: string; __overdue?: boolean }) =>
    c.status === "paid" ? "paid" : c.__overdue ? "overdue" : "pending",
  isManagerAddedOneOffCharge: () => false,
  chargeDueLabel: (c: { __overdue?: boolean }) => (c.__overdue ? "Due May 1, 2026" : "Due Jul 20, 2026"),
  // The KPI row asks each charge for its due date to total "due this period".
  householdChargeDueDate: (c: { __overdue?: boolean }) => (c.__overdue ? new Date(2026, 4, 1) : new Date(2026, 6, 20)),
}));

vi.mock("@/lib/manager-applications-storage", () => ({
  isBookingResidencyRow: (row: unknown) =>
    (row as { bookingResidency?: unknown } | null)?.bookingResidency === true,
  MANAGER_APPLICATIONS_EVENT: "manager-applications-changed",
  syncManagerApplicationsFromServer: () => Promise.resolve(),
  readManagerApplicationRows: () => [
    { id: "app-1", bucket: "pending", name: "Alex Kim", email: "alex@example.com", property: "Elm St #2", stage: "Screening" },
    { id: "app-2", bucket: "pending", name: "Jordan Fox", email: "jordan@example.com", property: "Oak Ave #5", stage: "Review" },
    { id: "app-3", bucket: "approved", name: "Riley Poe", email: "riley@example.com", property: "Elm St #1", stage: "Approved" },
    // N080: Dashboard/Payments now drop a charge whose resident has no
    // surviving directory (application) row. Dana/Sam are this scenario's
    // charge-holding residents (see CHARGES below), so give them one each —
    // otherwise the new filter treats their charges as orphaned data.
    { id: "app-4", bucket: "current", name: "Dana Ramirez", email: "dana@example.com", property: "Elm St #2", stage: "Current" },
    { id: "app-5", bucket: "current", name: "Sam Lee", email: "sam@example.com", property: "Oak Ave #5", stage: "Current" },
  ],
}));

vi.mock("@/lib/manager-portfolio-access", () => ({
  applicationVisibleToPortalUser: () => true,
  collectLinkedPropertyIdsForModule: () => new Set<string>(),
  moduleRowVisibleToPortalUser: () => true,
  syncManagerPortfolioFromServer: () => Promise.resolve(),
}));

vi.mock("@/lib/lease-pipeline-storage", () => ({
  LEASE_PIPELINE_EVENT: "lease-pipeline-changed",
  syncLeasePipelineFromServer: () => Promise.resolve(),
  readLeasePipeline: () => [
    {
      id: "lease-1",
      status: "Manager Signature Pending",
      updatedAtIso: "2026-06-30T00:00:00.000Z",
      residentName: "Dana Ramirez",
      residentEmail: "dana@example.com",
      unit: "Elm St #2",
      signedRentLabel: "$1,250/mo",
    },
  ],
}));

vi.mock("@/lib/portal-inbox-storage", () => ({
  MANAGER_INBOX_STORAGE_KEY: "manager-inbox",
  PORTAL_INBOX_CHANGED_EVENT: "portal-inbox-changed",
  syncPersistedInboxFromServer: () => Promise.resolve(),
  countUnopenedPersistedInbox: () => 3,
  loadPersistedInbox: () => [
    { id: "t-1", folder: "inbox", unread: true, from: "Dana Ramirez", subject: "Rent question", preview: "Hi..." },
  ],
}));

vi.mock("@/lib/demo-admin-property-inventory", () => ({
  adminKpiCounts: () => [2, 0, 4],
  // The portfolio overview reads property rows per stage; an empty portfolio
  // keeps this test about the banners.
  managerPropertyRowsForStage: () => [],
  adminPropertyRentDisplayLabel: () => "",
}));

vi.mock("@/lib/demo-admin-scheduling", () => ({
  getPartnerInquiryWindows: () => [],
  readPartnerInquiries: () => [],
  readPlannedEvents: () => [],
  syncScheduleRecordsFromServer: () => Promise.resolve(),
}));

vi.mock("@/lib/demo-admin-ui", () => ({ ADMIN_UI_EVENT: "admin-ui-changed" }));
vi.mock("@/lib/demo-property-pipeline", () => ({
  PROPERTY_PIPELINE_EVENT: "property-pipeline-changed",
  syncPropertyPipelineFromServer: () => Promise.resolve(),
  readPendingManagerPropertiesForUser: () => [
    {
      id: "prop-1",
      submittedAt: "2026-06-28T00:00:00.000Z",
      buildingName: "Elm Street Flats",
      address: "100 Elm St",
      zip: "98101",
      neighborhood: "Capitol Hill",
      unitLabel: "#2",
      beds: 2,
      baths: 1,
      monthlyRent: 1250,
      petFriendly: true,
      tagline: "Bright corner unit",
    },
  ],
  readScopedExtraListings: () => [{ id: "live-1" }],
}));


import { ManagerDashboard } from "@/components/portal/pro-dashboard";
import {
  MANAGER_DASHBOARD_SECTIONS,
  defaultDashboardVisibility,
  visibleDashboardSectionIds,
} from "@/lib/dashboard-preferences";

const renderedSectionIds = () =>
  [...document.querySelectorAll("[data-dashboard-section]")].map((el) => el.getAttribute("data-dashboard-section"));

describe("visibleDashboardSectionIds", () => {
  it("is the catalog order when everything is visible", () => {
    expect(visibleDashboardSectionIds(defaultDashboardVisibility())).toEqual(
      MANAGER_DASHBOARD_SECTIONS.map((s) => s.id),
    );
  });

  it("drops hidden sections and keeps the rest in catalog order", () => {
    const visibility = { ...defaultDashboardVisibility(), tours: false, cashflow: false };
    expect(visibleDashboardSectionIds(visibility)).toEqual(
      MANAGER_DASHBOARD_SECTIONS.map((s) => s.id).filter((id) => id !== "tours" && id !== "cashflow"),
    );
  });
});

describe("Manager dashboard — sections render in MANAGER_DASHBOARD_SECTIONS order", () => {
  afterEach(cleanup);

  it("draws every visible section once, in catalog order", () => {
    render(<ManagerDashboard />);
    // AI drafts only draws when the assistant has proposed something; this
    // scenario has none, so it is the one catalog id absent from the page.
    const expected = MANAGER_DASHBOARD_SECTIONS.map((s) => s.id).filter((id) => id !== "aiDrafts");
    expect(renderedSectionIds()).toEqual(expected);
  });
});
