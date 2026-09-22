// @vitest-environment jsdom
//
// "Remove so many costs… it should just be one payment."
//
// A signed lease bills first month, deposit, move-in fee and every one-time fee
// as separate charges — and they stay separate ledger lines, because the deposit
// is a liability. What collapses is the RESIDENT's view: Pending shows one
// "Move-in total" row, the breakdown sits behind it, and one Pay runs the
// existing multi-charge checkout over every line at once.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { HouseholdCharge } from "@/lib/household-charges";

const EMAIL = "maya@example.com";
const USER_ID = "res-maya";

// The resident 7-day visibility window (`household-charge-visibility.ts`)
// compares a charge's due date against the real wall clock at render time, so
// these labels are computed relative to "now" rather than pinned to a literal
// calendar date — `daysFromNowLabel(10)` always sits OUTSIDE the window (to
// prove a move-in group stays whole even when one of its lines individually
// would be hidden) and `daysFromNowLabel(3)` always sits INSIDE it.
function daysFromNowLabel(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function charge(over: Partial<HouseholdCharge> & { id: string; kind: HouseholdCharge["kind"]; title: string; amountLabel: string }): HouseholdCharge {
  return {
    createdAt: "2026-09-01T00:00:00.000Z",
    residentEmail: EMAIL,
    residentName: "Maya Chen",
    residentUserId: USER_ID,
    propertyId: "prop-8th",
    propertyLabel: "4709A 8th Ave NE",
    managerUserId: "mgr-1",
    balanceLabel: over.amountLabel,
    status: "pending",
    blocksLeaseUntilPaid: false,
    axisPaymentsEnabledSnapshot: true,
    managerStripeConnectReadySnapshot: true,
    ...over,
  };
}

const CHARGES: HouseholdCharge[] = [
  // Outside the 7-day window on its own — the group below still shows it
  // together with the rest of the move-in because its siblings (no due date)
  // are individually visible.
  charge({ id: "rent1", kind: "first_month_rent", title: "First month's rent", amountLabel: "$1,100.00", dueDateLabel: daysFromNowLabel(10) }),
  charge({ id: "dep", kind: "security_deposit", title: "Security deposit ($300.00 holding deposit credited)", amountLabel: "$800.00", blocksLeaseUntilPaid: true }),
  charge({ id: "fee", kind: "move_in_fee", title: "Move-in cost", amountLabel: "$250.00" }),
  charge({ id: "clean", kind: "other_cost", title: "Cleaning", amountLabel: "$150.00", customFeeId: "cf-clean" }),
  // A recurring month is NOT part of the move-in, and is within the window on
  // its own so it stays visible beside the group.
  charge({ id: "nov", kind: "rent", title: "November rent", amountLabel: "$1,100.00", recurringRentProfileId: "rp", dueDateLabel: daysFromNowLabel(3) }),
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
  const rows = [
    { id: "AXIS-1", name: "Maya Chen", email: "maya@example.com", property: "4709A 8th Ave NE", stage: "Current resident", bucket: "approved", managerUserId: "mgr-1", detail: "" },
  ];
  return { ...actual, syncManagerApplicationsFromServer: () => Promise.resolve(rows), readManagerApplicationRows: () => rows };
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

const checkoutBodies: Array<{ chargeIds: string[] }> = [];
vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.includes("/api/portal/household-charge-checkout") || url.includes("checkout")) {
    checkoutBodies.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response(JSON.stringify({ clientSecret: "cs_test", subtotalCents: 230000, totalCents: 230000 }), {
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
  return new Response(JSON.stringify({ rows: [], uploads: [], methods: [] }), { status: 200, headers: { "content-type": "application/json" } });
});

import { ResidentPaymentsPanel } from "@/components/portal/resident-payments-panel";
import { resetResidentLedgerCache } from "@/lib/resident-ledger-client";

afterEach(() => {
  cleanup();
  resetResidentLedgerCache();
  navigated.length = 0;
  checkoutBodies.length = 0;
});

const rowTexts = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('[data-slot="data-list-mobile-row"]')).map((row) =>
    (row.textContent ?? "").replace(/\s+/g, " ").trim(),
  );

describe("one move-in payment", () => {
  it("Pending shows ONE Move-in total row over the four move-in lines, beside the recurring month", async () => {
    const view = render(<ResidentPaymentsPanel bucket="pending" />);
    await waitFor(() => expect(screen.getAllByText("Move-in total").length).toBeGreaterThan(0));
    const rows = rowTexts(view.container);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("Move-in total");
    expect(rows[0]).toContain("$2,300.00");
    expect(rows[0]).toContain("4 items");
    expect(rows[1]).toContain("November rent");
    // Not one of the lines is drawn on its own.
    expect(rows.some((t) => t.includes("Security deposit"))).toBe(false);
    expect(rows.some((t) => t.includes("Move-in cost"))).toBe(false);
    // The tab counts the total as one charge.
    expect(screen.getByRole("link", { name: /^Pending/ }).textContent).toContain("2");
  });

  it("tapping the row opens the breakdown, where one Pay covers every line", async () => {
    render(<ResidentPaymentsPanel bucket="pending" />);
    await waitFor(() => expect(screen.getAllByText("Move-in total").length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText("Move-in total")[0]);
    expect(navigated[0]).toMatch(/\/resident\/payments\/pending\/movein%3A/);
    cleanup();

    const groupId = decodeURIComponent(navigated[0].split("/").pop() ?? "");
    const detail = render(<ResidentPaymentsPanel bucket="pending" chargeId={groupId} />);
    await waitFor(() => expect(screen.getByText("$2,300.00")).toBeTruthy());
    const breakdown = detail.container.querySelector('[data-attr="resident-payments-move-in-breakdown"]') as HTMLElement;
    const lines = Array.from(breakdown.querySelectorAll("li")).map((li) => (li.textContent ?? "").replace(/\s+/g, " ").trim());
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("First month's rent");
    expect(lines[0]).toContain("$1,100.00");
    expect(lines.some((t) => t.includes("holding deposit credited") && t.includes("$800.00"))).toBe(true);
    expect(lines.some((t) => t.includes("Cleaning"))).toBe(true);
    expect(lines.some((t) => t.includes("November rent"))).toBe(false);
    // The deposit still blocks the lease until paid, and says so once.
    expect(screen.getByText(/Pay this before signing your lease/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Pay $2,300.00" }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText("$2,300.00")).toBeTruthy();
    expect(within(sheet).getByText(/Move-in total · 4 items/)).toBeTruthy();
  });

  it("Pay all from the list still sends every payable line, the move-in ones included, in one checkout", async () => {
    render(<ResidentPaymentsPanel bucket="pending" />);
    await waitFor(() => expect(screen.getAllByText("Move-in total").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: "Pay all" }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText("$3,400.00")).toBeTruthy();
    expect(within(sheet).getByText("5 charges")).toBeTruthy();
  });
});
