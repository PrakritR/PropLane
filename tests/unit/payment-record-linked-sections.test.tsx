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
      activeBucket="pending"
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
  it("a plain rent charge offers Overview + Resident only — no Service, Vendor, Documents or Activity", () => {
    renderDetail(sampleRow({ chargeKind: "rent" }));
    const hrefs = railLinks().map((a) => a.getAttribute("href"));
    expect(hrefs.some((h) => h?.endsWith("/resident"))).toBe(true);
    expect(hrefs.some((h) => h?.endsWith("/service"))).toBe(false);
    expect(hrefs.some((h) => h?.endsWith("/vendor"))).toBe(false);
    expect(hrefs.some((h) => h?.endsWith("/documents"))).toBe(false);
    expect(hrefs.some((h) => h?.endsWith("/activity"))).toBe(false);
  });

  it("a work-order (service) charge offers the Service tab", () => {
    renderDetail(sampleRow({ chargeKind: "work_order_charge", chargeTitle: "Leaky faucet" }));
    const hrefs = railLinks().map((a) => a.getAttribute("href"));
    expect(hrefs.some((h) => h?.endsWith("/service"))).toBe(true);
    // Still never a vendor tab — the vendor side of that job is a separate, Outgoing record.
    expect(hrefs.some((h) => h?.endsWith("/vendor"))).toBe(false);
  });

  it("an imported charge offers Activity (it has a real migration event to show)", () => {
    renderDetail(sampleRow({ migrationSourceId: "2026-import.xlsx", createdAt: "2026-01-01T00:00:00.000Z" }));
    const hrefs = railLinks().map((a) => a.getAttribute("href"));
    expect(hrefs.some((h) => h?.endsWith("/activity"))).toBe(true);
    expect(hrefs.some((h) => h?.endsWith("/documents"))).toBe(false);
  });
});
