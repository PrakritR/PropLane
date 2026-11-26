// @vitest-environment jsdom
//
// A co-manager with Calendar linkage but no Applications access reads a peer-owned house's tour request as a
// free/busy projection: the server strips the prospect's name (`busyProjection`,
// src/lib/schedule-record-projection.server.ts). The dashboard's "Tour requests" row must still carry a title -
// a row rendering with no title at all is the bug this locks out.
//
// Oracle: the fallback its siblings already use for the same missing name (the planned-tour branch's
// "Confirmed tour", the Tours list's "Prospect"), i.e. a pending request always reads as a request. Plausible
// wrong behaviour this rejects: `label: r.name` rendering an empty title.
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

import { serviceChargeDisplayTitle } from "@/lib/service-charge-title";

vi.mock("@/lib/household-charges", () => ({
  HOUSEHOLD_CHARGES_EVENT: "household-charges-changed",
  syncHouseholdChargesFromServer: () => Promise.resolve({ charges: [], rentProfiles: [], ok: true }),
  readChargesForManager: () => CHARGES,
  isHouseholdChargeOverdue: (c: { __overdue?: boolean }) => Boolean(c.__overdue),
  // The dashboard now buckets through the same helper the Payments tabs use, so
  // the two surfaces can't disagree (F-PAY-1). Mirror the scenario's __overdue flag.
  householdChargeManagerBucket: (c: { status?: string; __overdue?: boolean }) =>
    c.status === "paid" ? "paid" : c.__overdue ? "overdue" : "pending",
  isManagerAddedOneOffCharge: () => false,
  // The dashboard reads a charge's title through the shared normalizer, so a legacy
  // "Work order · …" row reads "Service · …" here too (AGENTS.md: no "work orders").
  householdChargeDisplayTitle: (c: { kind?: string | null; title?: string | null }, fallback = "Charge") =>
    serviceChargeDisplayTitle(c, fallback),
  chargeDueLabel: (c: { __overdue?: boolean }) => (c.__overdue ? "Due May 1, 2026" : "Due Jul 20, 2026"),
  // The KPI row asks each charge for its due date to total "due this period".
  householdChargeDueDate: (c: { __overdue?: boolean }) => (c.__overdue ? new Date(2026, 4, 1) : new Date(2026, 6, 20)),
}));

vi.mock("@/lib/manager-applications-storage", () => ({
  isBookingResidencyRow: (row: unknown) =>
    (row as { bookingResidency?: unknown } | null)?.bookingResidency === true,
  MANAGER_APPLICATIONS_EVENT: "manager-applications-changed",
  syncManagerApplicationsFromServer: () => Promise.resolve(),
  managerApplicationsReadSucceeded: () => true,
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
  leasePipelineReadSucceeded: () => true,
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

vi.mock("@/lib/portal-inbox-storage", async (importOriginal) => ({
  // The unread count folds rows into conversations through the real storage helpers.
  ...(await importOriginal<typeof import("@/lib/portal-inbox-storage")>()),
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

// Exactly what the server's busy projection keeps: no name, no email, no property title.
const BUSY_WINDOW = { start: "2026-07-02T17:00:00.000Z", end: "2026-07-02T17:30:00.000Z" };
const BUSY_INQUIRY = {
  id: "inq-busy",
  kind: "tour",
  status: "pending",
  propertyId: "peer-house",
  managerUserId: "peer-mgr",
  requestedWindows: [BUSY_WINDOW],
};

vi.mock("@/lib/demo-admin-scheduling", () => ({
  getPartnerInquiryWindows: () => [BUSY_WINDOW],
  readPartnerInquiries: () => [BUSY_INQUIRY],
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

describe("Manager dashboard tour rows from a free/busy projection", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("titles a request whose prospect name the projection stripped", () => {
    vi.setSystemTime(new Date("2026-07-01T17:00:00.000Z"));
    render(<ManagerDashboard />);
    const rows = [...document.querySelectorAll('[data-attr="dashboard-attention-tour"]')];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain("Tour request");
  });
});
