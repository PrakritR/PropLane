// @vitest-environment jsdom
//
// C139: the charge record page gets a phone-only sticky "Pay $X" bar above
// the bottom tab bar, alongside the existing header Pay button (desktop
// parity unchanged). Same mocking harness as resident-payments-pay-copy.test.tsx.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { HouseholdCharge } from "@/lib/household-charges";

const EMAIL = "maya@example.com";
const USER_ID = "res-maya";

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

vi.mock("next/navigation", () => ({
  usePathname: () => "/resident/payments/pending/rent-oct",
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
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => (_href: string) => {} }));
vi.mock("@/hooks/use-native-platform", () => ({ useNativePlatform: () => null }));
vi.mock("@/lib/household-charges", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/household-charges")>();
  return { ...actual, syncHouseholdChargesFromServer: () => Promise.resolve(), readChargesForResident: () => CHARGES };
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

vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes("checkout")) {
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
});

describe("resident charge record — sticky Pay bar (C139)", () => {
  it("renders a phone-only sticky Pay bar naming the balance", async () => {
    render(<ResidentPaymentsPanel bucket="pending" chargeId="rent-oct" />);
    const bar = await waitFor(() => {
      const el = document.querySelector('[data-attr="resident-payment-sticky-pay-bar"]');
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    expect(bar.textContent).toContain("Pay $1,205.00");
    expect(bar.className).toContain("lg:hidden");
  });

  it("opens the pay confirmation when tapped", async () => {
    render(<ResidentPaymentsPanel bucket="pending" chargeId="rent-oct" />);
    const button = await waitFor(() => {
      const el = document.querySelector('[data-attr="resident-payment-sticky-pay-bar-button"]');
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    fireEvent.click(button);
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("$1,205.00");
  });
});
