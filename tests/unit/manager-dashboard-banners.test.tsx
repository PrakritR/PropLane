// @vitest-environment jsdom
//
// Renders the manager Dashboard with a scenario that has action items (overdue
// charges, apps, leases, inbox, properties). Locks in the "remove all
// top-of-page notification banners" change: NO NotifBanner strip renders on the
// dashboard, while the separate "Pending & overdue payments" table (which still
// lists overdue charges) stays.
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

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
}));

vi.mock("@/lib/manager-applications-storage", () => ({
  MANAGER_APPLICATIONS_EVENT: "manager-applications-changed",
  syncManagerApplicationsFromServer: () => Promise.resolve(),
  readManagerApplicationRows: () => [
    { id: "app-1", bucket: "pending", name: "Alex Kim", email: "alex@example.com", property: "Elm St #2", stage: "Screening" },
    { id: "app-2", bucket: "pending", name: "Jordan Fox", email: "jordan@example.com", property: "Oak Ave #5", stage: "Review" },
    { id: "app-3", bucket: "approved", name: "Riley Poe", email: "riley@example.com", property: "Elm St #1", stage: "Approved" },
  ],
}));

vi.mock("@/lib/manager-portfolio-access", () => ({
  applicationVisibleToPortalUser: () => true,
  collectLinkedPropertyIdsForModule: () => new Set<string>(),
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

describe("Manager dashboard — top notification banners removed", () => {
  afterEach(cleanup);

  it("renders no top-of-page notification banner strip, even with action items", () => {
    render(<ManagerDashboard />);

    // No NotifBanner pills of any tone render anywhere on the dashboard.
    expect(document.querySelector(".portal-banner-danger")).toBeNull();
    expect(document.querySelector(".portal-banner-info")).toBeNull();
    expect(document.querySelector(".portal-banner-pending")).toBeNull();
    // The old action-required banner copy is gone.
    expect(screen.queryByText(/overdue charges? totalling/i)).toBeNull();
    expect(screen.queryByText(/waiting for a decision/i)).toBeNull();
  });

  it("still surfaces the overdue charge in the payments attention group", () => {
    render(<ManagerDashboard />);
    expect(screen.getByText("Payments")).toBeTruthy();
    expect(screen.getAllByText(/1 overdue/).length).toBeGreaterThan(0);
    const overdueBadges = screen.getAllByText(/^Overdue$/i);
    expect(overdueBadges.length).toBeGreaterThan(0);
    // The overdue charge's resident + charge title appear in the payments table.
    expect(screen.getAllByText("Dana Ramirez").length).toBeGreaterThan(0);
    expect(screen.getByText(/May rent/)).toBeTruthy();
  });
});
