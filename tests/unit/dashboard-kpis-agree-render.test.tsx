// @vitest-environment jsdom
/**
 * Round 7 (plan avail-kpis-1117), on the rendered dashboard: renders the real manager Dashboard over one
 * fixed scenario and writes the rendered HTML to `EVIDENCE_DIR`, so a reviewer can see that
 * Rent collected / due are read over the same charges, Residents is people living today, and
 * Applications ready is the Pending tab's waiting-for-a-decision count.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { mkdirSync, writeFileSync } from "node:fs";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
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

vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => ({ userId: "mgr-1", email: "mgr@example.com", ready: true }),
}));

// ── The scenario's charges. November is the current period (today: 2026-11-17).
//    A: November rent paid EARLY (October).            B: November rent paid in November.
//    C: OCTOBER rent paid late, in November.           D: November rent still unpaid.
//    E: a November charge that was REFUNDED.
const base = {
  kind: "one_off" as const,
  residentUserId: null,
  managerUserId: "mgr-1",
  propertyId: "house-1",
  propertyLabel: "Brooklyn House",
  balanceLabel: "$0.00",
};
const CHARGES = [
  { ...base, id: "chg-a", createdAt: "2026-10-01T00:00:00.000Z", residentName: "Dana Ramirez", residentEmail: "dana@example.com", title: "November rent", amountLabel: "$1,000.00", status: "paid", paidAt: "2026-10-28T10:00:00.000Z", dueDateLabel: "2026-11-01" },
  { ...base, id: "chg-b", createdAt: "2026-10-05T00:00:00.000Z", residentName: "Sam Lee", residentEmail: "sam@example.com", title: "November rent", amountLabel: "$800.00", status: "paid", paidAt: "2026-11-16T10:00:00.000Z", dueDateLabel: "2026-11-05" },
  { ...base, id: "chg-c", createdAt: "2026-09-01T00:00:00.000Z", residentName: "Dana Ramirez", residentEmail: "dana@example.com", title: "October rent", amountLabel: "$700.00", status: "paid", paidAt: "2026-11-02T10:00:00.000Z", dueDateLabel: "2026-10-01" },
  { ...base, id: "chg-d", createdAt: "2026-10-20T00:00:00.000Z", residentName: "Sam Lee", residentEmail: "sam@example.com", title: "November rent", amountLabel: "$500.00", balanceLabel: "$500.00", status: "pending", dueDateLabel: "2026-11-09" },
  { ...base, id: "chg-e", createdAt: "2026-11-01T00:00:00.000Z", residentName: "Dana Ramirez", residentEmail: "dana@example.com", title: "Cleaning fee", amountLabel: "$400.00", status: "refunded", paidAt: "2026-11-13T10:00:00.000Z", dueDateLabel: "2026-11-12" },
];

vi.mock("@/lib/household-charges", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/household-charges")>()),
  syncHouseholdChargesFromServer: () => Promise.resolve({ ok: true, charges: [], rentProfiles: [] }),
}));

vi.mock("@/lib/manager-payments-scope", () => ({
  readManagerPaymentsLedgerCharges: () => CHARGES,
  unpaidManagerPaymentCharges: (rows: typeof CHARGES) => rows.filter((c) => c.status === "pending"),
  managerPaymentBucketCounts: () => ({ pending: 1, overdue: 0, paid: 3 }),
}));

vi.mock("@/lib/manager-applications-storage", () => ({
  isBookingResidencyRow: (row: { bookingResidency?: unknown } | null) => Boolean(row?.bookingResidency),
  MANAGER_APPLICATIONS_EVENT: "manager-applications-changed",
  syncManagerApplicationsFromServer: () => Promise.resolve(),
  managerApplicationsReadSucceeded: () => true,
  normalizeApplicationAxisId: (id: string) => id,
  readManagerApplicationRows: () => [
    { id: "app-1", bucket: "pending", stage: "Submitted", name: "Alex Kim", email: "alex@example.com", property: "Brooklyn House · Room 1", propertyId: "house-1", detail: "Submitted Nov 12" },
    { id: "app-2", bucket: "pending", stage: "Submitted", name: "Jordan Fox", email: "jordan@example.com", property: "Brooklyn House · Room 2", propertyId: "house-1", detail: "Submitted Nov 14" },
    // In the Pending tab, but nobody can decide on it: withdrawn.
    { id: "app-3", bucket: "pending", stage: "Submitted", name: "Casey Park", email: "casey@example.com", property: "Brooklyn House · Room 5", propertyId: "house-1", withdrawnAt: "2026-11-15T00:00:00.000Z" },
    // Never an application row on the page: a booking residency and a merged duplicate.
    { id: "app-4", bucket: "pending", stage: "Submitted", name: "Guest Stay", email: "guest@example.com", property: "Brooklyn House", propertyId: "house-1", bookingResidency: true },
    { id: "app-5", bucket: "pending", stage: "Submitted", name: "Alex Kim", email: "alex@example.com", property: "Brooklyn House", propertyId: "house-1", mergedInto: "app-1" },
    { id: "app-6", bucket: "approved", stage: "Current", name: "Dana Ramirez", email: "dana@example.com", property: "Brooklyn House · Room 3", propertyId: "house-1" },
    { id: "app-7", bucket: "approved", stage: "Current", name: "Sam Lee", email: "sam@example.com", property: "Brooklyn House · Room 4", propertyId: "house-1" },
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
      status: "Signed",
      updatedAtIso: "2026-10-30T00:00:00.000Z",
      residentName: "Dana Ramirez",
      residentEmail: "dana@example.com",
      unit: "Brooklyn House · Room 3",
      propertyId: "house-1",
      signedRentLabel: "$1,000/mo",
    },
  ],
}));

vi.mock("@/lib/portal-inbox-storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/portal-inbox-storage")>()),
  syncPersistedInboxFromServerWithStatus: () => Promise.resolve({ ok: true }),
  loadPersistedInbox: () => [],
}));

vi.mock("@/lib/demo-admin-property-inventory", () => ({
  adminKpiCounts: () => [1, 0, 0],
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
  readPendingManagerPropertiesForUser: () => [],
  readScopedExtraListings: () => [{ id: "house-1" }],
}));

// Live occupancy: 22 people living in 30 beds today, every day the KPI card reads.
vi.mock("@/hooks/use-portfolio-occupancy", async () => {
  const { dashboardOccupancyDayKeys } = await import("@/lib/dashboard-occupancy");
  const { pacificTodayKey } = await import("@/lib/room-availability-range");
  return {
    PORTFOLIO_OCCUPANCY_TIMEOUT_MS: 12_000,
    usePortfolioOccupancy: (_ids: readonly string[], _enabled: boolean, periods: readonly unknown[]) => {
      const today = pacificTodayKey();
      const days = dashboardOccupancyDayKeys(today, periods as never).map((dayKey) => ({
        dayKey,
        occupied: 22,
        inHouse: 22,
        total: 30,
        checkIns: 0,
        checkOuts: 0,
        houses: [{ propertyId: "house-1", occupied: 22, inHouse: 22, total: 30 }],
      }));
      return { status: "ok" as const, snapshot: { days, stays: [], version: "evidence" }, today, retry: () => {} };
    },
  };
});

// Charts are their own reads; this evidence render is about the KPI figures.
vi.mock("@/components/portal/finances/financial-cashflow-chart", () => ({ FinancialCashflowChart: () => null }));
vi.mock("@/components/portal/monthly-profit-chart", () => ({ MonthlyProfitChart: () => null }));

import { ManagerDashboard } from "@/components/portal/pro-dashboard";

function writeEvidence(name: string, html: string) {
  const dir = process.env.EVIDENCE_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/${name}`, html);
}

beforeEach(() => {
  // Pinned day: November 2026 is the current period the KPI figures below describe.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-17T20:00:00.000Z"));
  // Not the demo surface: the dashboard reads live occupancy only outside /demo and "/".
  window.history.replaceState({}, "", "/portal/dashboard");
  // Every other read answers empty rather than throwing on a relative URL in jsdom.
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ rows: [], items: [] }), { status: 200, headers: { "content-type": "application/json" } }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("dashboard KPIs agree (evidence render)", () => {
  it("Rent collected is the paid part of the SAME charges counted as due", async () => {
    const { container } = render(<ManagerDashboard />);
    await screen.findByText("Rent collected");
    const text = container.textContent ?? "";
    // November: $1,000 + $800 + $500 + $400 due; $1,800 of it cleared (the refund is not collected).
    expect(text).toContain("$1,800");
    expect(text).toContain("of $2,700 due");
    writeEvidence(
      "dashboard-kpis.html",
      `<!doctype html><html><head><meta charset="utf-8"><title>Manager dashboard · KPIs agree</title></head><body>${container.innerHTML}</body></html>`,
    );
  });

  it("Residents counts people living today, and Applications counts the Pending tab's decisions", async () => {
    render(<ManagerDashboard />);
    await screen.findByText("Residents");
    const residents = document.querySelector('[data-attention-group="residents"]')?.textContent ?? document.body.textContent ?? "";
    expect(residents).toContain("22");
    // The Applications KPI is the Pending tab's count (3: two submitted + one withdrawn), and the
    // attention list holds only the 2 nobody has decided on.
    expect(document.body.textContent).toContain("Applications ready");
    expect(document.body.textContent).toMatch(/Applications to approve2/);
  });
});
