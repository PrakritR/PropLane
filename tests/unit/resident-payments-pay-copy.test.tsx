// @vitest-environment jsdom
//
// PLAN-0920-0853 (resident slice): the resident charges modal never says
// "Continue to Stripe" / "Stripe". Reshaped by C2-RJ11 (see below).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { HouseholdCharge } from "@/lib/household-charges";

const EMAIL = "maya@example.com";
const USER_ID = "res-maya";

// The resident 7-day visibility window (`household-charge-visibility.ts`)
// compares this charge's due date against the real wall clock at render
// time, so the label is computed relative to "now" rather than pinned to a
// literal calendar date that would eventually fall outside the window.
function daysFromNowLabel(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

const CHARGES: HouseholdCharge[] = [
  {
    id: "rent-oct",
    kind: "rent",
    title: "Rent — October 2026",
    amountLabel: "$1,205.00",
    balanceLabel: "$1,205.00",
    createdAt: "2026-09-01T00:00:00.000Z",
    residentEmail: EMAIL,
    residentName: "Maya Chen",
    residentUserId: USER_ID,
    propertyId: "prop-8th",
    propertyLabel: "4709A 8th Ave NE",
    managerUserId: "mgr-1",
    status: "pending",
    blocksLeaseUntilPaid: false,
    axisPaymentsEnabledSnapshot: true,
    managerStripeConnectReadySnapshot: true,
    dueDateLabel: daysFromNowLabel(3),
  },
];

const navigated: string[] = [];
vi.mock("next/navigation", () => ({
  usePathname: () => "/resident/payments/pending",
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => () => Promise.resolve(true),
  useAppUi: () => ({ showToast: () => {} }),
}));
vi.mock("@/hooks/use-portal-session", () => ({
  usePortalSession: () => ({ ready: true, email: EMAIL, userId: USER_ID, displayName: "Maya Chen" }),
}));
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => (href: string) => navigated.push(href) }));
vi.mock("@/hooks/use-native-platform", () => ({ useNativePlatform: () => null }));
vi.mock("@/lib/household-charges", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/household-charges")>();
  return {
    ...actual,
    syncHouseholdChargesFromServer: () => Promise.resolve(),
    readChargesForResident: () => CHARGES,
  };
});
vi.mock("@/lib/manager-applications-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/manager-applications-storage")>();
  return { ...actual, syncManagerApplicationsFromServer: () => Promise.resolve([]), readManagerApplicationRows: () => [] };
});
vi.mock("@/lib/lease-pipeline-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/lease-pipeline-storage")>();
  return { ...actual, syncLeasePipelineFromServer: () => Promise.resolve([]), readLeasePipeline: () => [], findLeaseForResidentEmail: () => null };
});
vi.mock("@/lib/demo-property-pipeline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/demo-property-pipeline")>();
  return { ...actual, syncPropertyPipelineFromServer: () => Promise.resolve(undefined) };
});
vi.mock("@/lib/supabase/browser", () => ({ createSupabaseBrowserClient: () => null }));
vi.mock("@/lib/demo/demo-session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/demo/demo-session")>();
  return { ...actual, isDemoModeActive: () => false };
});
vi.mock("@/components/stripe-embedded-checkout", () => ({
  StripeEmbeddedCheckout: () => <div data-testid="stripe-checkout" />,
}));

vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.includes("household-charge-checkout") || url.includes("checkout")) {
    void init;
    return new Response(JSON.stringify({ clientSecret: "cs_test", subtotalCents: 120500, totalCents: 120500 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (url.includes("/api/reports/resident-ledger")) {
    return new Response(JSON.stringify({ id: "resident-ledger", title: "Resident ledger", columns: [], rows: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ rows: [], uploads: [], methods: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});

import { ResidentPaymentsPanel } from "@/components/portal/resident-payments-panel";
import { resetResidentLedgerCache } from "@/lib/resident-ledger-client";

afterEach(() => {
  cleanup();
  resetResidentLedgerCache();
  navigated.length = 0;
});

// C2-RJ11 (studio-redesign-0929): the amount sheet and the card sheet are ONE
// sheet — charges, a Processing fee line, the card/bank picker and the embedded
// checkout (which carries the single Pay button). There is no "Continue to
// Stripe" step and no second Pay button of the panel's own.
describe("resident charges modal — one checkout sheet", () => {
  it('shows "$1,205.00" and a processing-fee line, never "Continue to Stripe" or the word Stripe', async () => {
    render(<ResidentPaymentsPanel bucket="pending" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Pay all" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Pay all" }));

    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(dialog.textContent ?? "").toContain("$1,205.00"));
    expect(dialog.textContent ?? "").toMatch(/Processing fee/);
    expect(dialog.querySelector('[data-attr="resident-payments-confirm-pay"]')).toBeNull();
    expect(dialog.textContent ?? "").not.toContain("Continue to Stripe");
    expect(dialog.textContent ?? "").not.toMatch(/\bStripe\b/);
  });

  it("opens the embedded checkout straight away, without a confirm step", async () => {
    render(<ResidentPaymentsPanel bucket="pending" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Pay all" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Pay all" }));

    await screen.findByRole("dialog");
    await waitFor(() => expect(screen.getByTestId("stripe-checkout")).toBeTruthy());
  });
});
