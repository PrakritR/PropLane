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
vi.mock("@/components/portal/resident-bank-account-form", () => ({
  ResidentBankAccountForm: ({ intentId }: { intentId: string }) => <div data-testid="bank-form">{intentId}</div>,
}));

const requests: Array<{ url: string; method: string }> = [];
vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  requests.push({ url, method: init?.method ?? "GET" });
  if (url.includes("/api/stripe/resident-ach-payment?payment_intent_id=pi_original")) {
    return new Response(JSON.stringify({ clientSecret: "pi_secret_original", chargeIds: ["rent-oct"],
      bankStatus: "verification", subtotalCents: 120500, processingFeeCents: 500,
      axisFeeCents: 0, totalCents: 121000 }), { status: 200 });
  }
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
  CHARGES[0]!.status = "pending";
  CHARGES[0]!.stripeCheckoutSessionId = undefined;
  CHARGES[0]!.balanceLabel = "$1,205.00";
  CHARGES[0]!.paidAmountCents = undefined;
  requests.length = 0;
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

  it("opens the exact bank verification form for one processing charge without creating another payment", async () => {
    CHARGES[0]!.status = "processing";
    CHARGES[0]!.stripeCheckoutSessionId = "pi_original";
    render(<ResidentPaymentsPanel bucket="pending" chargeId="rent-oct" />);
    fireEvent.click(screen.getByRole("button", { name: "Verify bank or check status" }));
    expect(await screen.findByTestId("bank-form")).toHaveTextContent("pi_original");
    expect(screen.getByText("Processing fee $5.00")).toBeInTheDocument();
    expect(requests.filter(({ url }) => url.includes("/api/stripe/resident-ach-payment?payment_intent_id=pi_original"))).toHaveLength(1);
    expect(requests.filter(({ method }) => method === "POST")).toHaveLength(0);
    expect(requests.some(({ url }) => url.includes("household-charge-checkout"))).toBe(false);
  });

  it("a paid charge's detail shows the amount paid (not the $0.00 balance) and no 'manager will update' text", async () => {
    CHARGES[0]!.status = "paid";
    CHARGES[0]!.balanceLabel = "$0.00";
    CHARGES[0]!.paidAmountCents = 120500;
    CHARGES[0]!.paidAt = "2026-10-05T10:00:00.000Z";
    render(<ResidentPaymentsPanel bucket="paid" chargeId="rent-oct" />);
    await waitFor(() => expect(screen.getAllByText("$1,205.00").length).toBeGreaterThan(0));
    const amount = Array.from(document.querySelectorAll("*")).find((el) => el.children.length === 0 && el.textContent === "Amount");
    expect(amount?.parentElement?.textContent).toContain("$1,205.00");
    expect(amount?.parentElement?.textContent).not.toContain("$0.00");
    expect(screen.queryByText(/will update this charge/)).toBeNull();
  });

  it("an unpaid charge that cannot be paid online still tells the resident the manager will update it", async () => {
    CHARGES[0]!.axisPaymentsEnabledSnapshot = false;
    render(<ResidentPaymentsPanel bucket="pending" chargeId="rent-oct" />);
    await waitFor(() => expect(screen.getByText(/will update this charge/)).toBeInTheDocument());
    CHARGES[0]!.axisPaymentsEnabledSnapshot = true;
  });
});
