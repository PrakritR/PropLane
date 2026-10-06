// @vitest-environment jsdom
//
// C095: the payment record page used to render Service/Vendor/Documents/
// Activity for every charge, each with an empty-state message even when that
// tab could never have real content (a resident charge is never a vendor
// payment, and no upload path exists for a charge's "documents"). This
// verifies the rail only ever offers a tab that can actually have data.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { DemoManagerPaymentLedgerRow } from "@/data/demo-portal";
import { ManagerPaymentsLedgerPanel } from "@/components/portal/pro-payments-ledger-panel";
import { householdChargeToLedgerRow, seedDemoHouseholdCharges, type HouseholdCharge } from "@/lib/household-charges";

vi.mock("@/lib/portal-nav-client", () => ({
  usePortalNavigate: () => vi.fn(),
}));

vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => vi.fn(async () => true),
  useAppUi: () => ({ showToast: vi.fn() }),
}));

vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => "mgr-test",
}));

vi.mock("@/lib/portal-base-path-client", () => ({
  usePaidPortalBasePath: () => "/portal",
}));

vi.mock("@/components/portal/workspace-provider", () => ({
  useWorkspaces: () => ({ active: { name: "Seattle Homes" } }),
}));

vi.mock("@/components/portal/payment-schedule-ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/portal/payment-schedule-ui")>();
  return {
    ...actual,
    useScheduledPaymentMessages: () => ({ messages: [], settings: null, reload: async () => undefined }),
  };
});

vi.stubGlobal(
  "fetch",
  async () =>
    new Response(JSON.stringify({ messages: [], settings: null, rows: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
);

afterEach(() => {
  cleanup();
  seedDemoHouseholdCharges([]);
});

function sampleRow(overrides: Partial<DemoManagerPaymentLedgerRow> = {}): DemoManagerPaymentLedgerRow {
  return {
    id: "hc_test_1",
    propertyName: "The Magnolia",
    roomNumber: "2B",
    residentName: "Maya Chen",
    residentEmail: "maya@example.com",
    chargeTitle: "July rent",
    lineAmount: "$1,850.00",
    amountPaid: "$0.00",
    balanceDue: "$1,850.00",
    dueDate: "Jul 1, 2026",
    dueDateSortMs: Date.parse("2026-07-01"),
    bucket: "pending",
    statusLabel: "Pending",
    notes: "",
    householdChargeId: "hc_test_1",
    ...overrides,
  };
}

function renderDetail(row: DemoManagerPaymentLedgerRow) {
  return render(
    <ManagerPaymentsLedgerPanel
      rows={[row]}
      managerUserId="mgr-test"
      activeBucket={row.bucket}
      direction="incoming"
      listBasePath="/portal"
      paymentId={row.id}
    />,
  );
}

function railLinks(): HTMLAnchorElement[] {
  return Array.from(document.querySelectorAll('nav[aria-label="Payment sections"] a[href]'));
}

describe("payment record page hides tabs that can never have content (C095)", () => {
  it("a plain rent charge offers Payment + Communication only — no Service, Vendor, Documents or Activity", () => {
    renderDetail(sampleRow({ chargeKind: "rent" }));
    const hrefs = railLinks().map((a) => a.getAttribute("href"));
    expect(hrefs.some((h) => h?.endsWith("/communication"))).toBe(true);
    expect(hrefs.some((h) => h?.endsWith("/service"))).toBe(false);
    expect(hrefs.some((h) => h?.endsWith("/vendor"))).toBe(false);
    expect(hrefs.some((h) => h?.endsWith("/documents"))).toBe(false);
    expect(hrefs.some((h) => h?.endsWith("/activity"))).toBe(false);
  });

  it("a service charge keeps the same Payment + Communication rail", () => {
    renderDetail(sampleRow({ chargeKind: "work_order_charge", chargeTitle: "Leaky faucet" }));
    const hrefs = railLinks().map((a) => a.getAttribute("href"));
    expect(hrefs.some((h) => h?.endsWith("/service"))).toBe(false);
    // Still never a vendor tab — the vendor side of that job is a separate, Outgoing record.
    expect(hrefs.some((h) => h?.endsWith("/vendor"))).toBe(false);
  });

  it("an imported charge keeps its events in Payment history", () => {
    renderDetail(sampleRow({ migrationSourceId: "2026-import.xlsx", createdAt: "2026-01-01T00:00:00.000Z" }));
    const hrefs = railLinks().map((a) => a.getAttribute("href"));
    expect(hrefs.some((h) => h?.endsWith("/activity"))).toBe(false);
    expect(hrefs.some((h) => h?.endsWith("/documents"))).toBe(false);
  });
});

// C095: Overview renders the shared StatTile/RecordFactCard kit
// (`portal-record-overview-kit.tsx`, docs/agents/record-page.md point 3)
// instead of the bespoke grid every other kind had already moved off of.
describe("payment record Overview uses the shared record-page kit (C095)", () => {
  it("shows an offline Check receipt without claiming money entered workspace balance", () => {
    const charge: HouseholdCharge = { id: "hc-offline", createdAt: "2026-10-04T12:00:00Z",
      residentEmail: "resident@example.test", residentName: "Resident", residentUserId: null,
      propertyId: "property-1", propertyLabel: "The Magnolia", managerUserId: "mgr-test", kind: "rent",
      title: "October rent", amountLabel: "$1.00", balanceLabel: "$0.00", status: "paid",
      paidAt: "2026-10-05T12:00:00Z", paidMethod: "Check", blocksLeaseUntilPaid: false };
    seedDemoHouseholdCharges([charge]);
    const row = householdChargeToLedgerRow(charge);
    const { container } = renderDetail(row);
    const details = container.querySelector('[data-attr="payment-overview-card-details"]')?.textContent ?? "";
    expect(details).toContain("Paid via");
    expect(details).toContain("Check");
    expect(details).not.toContain("workspace balance");
    expect(details).not.toContain("Awaiting payment");
    expect(container.querySelector('[aria-label="Refund"]')).toBeNull();
    expect(row.notes).not.toBe("Awaiting payment.");
  });

  it("offers Refund for a paid provider-backed charge", () => {
    const charge: HouseholdCharge = { id: "hc-provider", createdAt: "2026-10-04T12:00:00Z",
      residentEmail: "resident@example.test", residentName: "Resident", residentUserId: null,
      propertyId: "property-1", propertyLabel: "The Magnolia", managerUserId: "mgr-test", kind: "rent",
      title: "October rent", amountLabel: "$1.00", balanceLabel: "$0.00", status: "paid",
      paidAt: "2026-10-05T12:00:00Z", stripeCheckoutSessionId: "cs_test_paid", blocksLeaseUntilPaid: false };
    seedDemoHouseholdCharges([charge]);
    const { container } = renderDetail(householdChargeToLedgerRow(charge));
    expect(container.querySelector('[aria-label="Refund"]')).not.toBeNull();
  });

  it("does not offer Return deposit for an offline deposit receipt", () => {
    const charge: HouseholdCharge = { id: "hc-deposit", createdAt: "2026-10-04T12:00:00Z",
      residentEmail: "resident@example.test", residentName: "Resident", residentUserId: null,
      propertyId: "property-1", propertyLabel: "The Magnolia", managerUserId: "mgr-test", kind: "security_deposit",
      title: "Deposit", amountLabel: "$1.00", balanceLabel: "$0.00", status: "paid",
      paidAt: "2026-10-05T12:00:00Z", paidMethod: "Check", blocksLeaseUntilPaid: false };
    seedDemoHouseholdCharges([charge]);
    const { container } = renderDetail(householdChargeToLedgerRow(charge));
    expect(container.querySelector('[aria-label="Return deposit"]')).toBeNull();
  });
  it("shows amount, status, due date and days tiles with Details and History", () => {
    const { container } = renderDetail(sampleRow());
    expect(container.querySelector('[data-attr="payment-overview-tile-amount"]')?.textContent).toContain(
      "$1,850.00",
    );
    expect(container.querySelector('[data-attr="payment-overview-tile-days"]')).not.toBeNull();
    expect(container.querySelector('[data-attr="payment-overview-tile-due"]')?.textContent).toContain(
      "Jul 1, 2026",
    );
    expect(container.querySelector('[data-attr="payment-overview-tile-status"]')?.textContent).toContain(
      "Pending",
    );
    const detailsCard = container.querySelector('[data-attr="payment-overview-card-details"]');
    expect(detailsCard?.textContent).toContain("The Magnolia");
    expect(detailsCard?.textContent).toContain("July rent");
    expect(detailsCard?.textContent).toContain("Maya Chen");
    expect(container.querySelector('[data-attr="payment-overview-history"]')).not.toBeNull();
  });

  it("preserves resident messages in Details", () => {
    const { container } = renderDetail(
      sampleRow({
        residentChargeMessages: [{ id: "msg1", body: "Can I pay this in two parts?", sentAt: "2026-06-30T12:00:00.000Z" }],
      }),
    );
    expect(container.querySelector('[data-attr="payment-overview-card-details"]')?.textContent).toContain(
      "Can I pay this in two parts?",
    );
  });

  it("omits the Resident message card when there is none", () => {
    const { container } = renderDetail(sampleRow());
    expect(container.querySelector('[data-attr="payment-overview-card-resident-message"]')).toBeNull();
  });
});
