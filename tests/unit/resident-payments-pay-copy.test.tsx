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

const checkoutRequests: RequestInit[] = [];
vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.includes("household-charge-checkout") || url.includes("checkout")) {
    checkoutRequests.push(init ?? {});
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
  checkoutRequests.length = 0;
});

// Selection is local until Continue freezes the chosen method and asks the
// server for its exact priced claim.
describe("resident charges modal — one checkout sheet", () => {
  it('shows "$1,205.00" and pending fee disclosure without claiming a final fee before Continue', async () => {
    render(<ResidentPaymentsPanel bucket="pending" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Pay all" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Pay all" }));

    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(dialog.textContent ?? "").toContain("$1,205.00"));
    expect(dialog.textContent ?? "").toContain("Final total and fees appear before you confirm.");
    expect(dialog.textContent ?? "").not.toContain("Processing fee: None");
    expect(dialog.querySelector('[data-attr="resident-payments-confirm-pay"]')).toBeNull();
    expect(dialog.textContent ?? "").not.toContain("Continue to Stripe");
    expect(dialog.textContent ?? "").not.toMatch(/\bStripe\b/);
    expect(checkoutRequests).toHaveLength(0);
  });

  it("opens embedded Card checkout only after explicit Continue", async () => {
    render(<ResidentPaymentsPanel bucket="pending" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Pay all" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Pay all" }));

    await screen.findByRole("dialog");
    expect(checkoutRequests).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: /Card.*Apple Pay/ }));
    expect(checkoutRequests).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: /Continue with Card/ }));
    await waitFor(() => expect(screen.getByTestId("stripe-checkout")).toBeTruthy());
    expect(checkoutRequests).toHaveLength(1);
    expect(JSON.parse(String(checkoutRequests[0]?.body))).toMatchObject({ paymentMethod: "card" });
  });
});
