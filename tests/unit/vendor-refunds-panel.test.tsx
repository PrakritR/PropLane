// @vitest-environment jsdom
//
// vendor-banking-1006: Finances -> Refunds. The list is the shared record row with a glyph
// status fact (never a pill); the pop-up shows the plan's preview and sends a stable
// Idempotency-Key with only the gross amount and the reason.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const showToast = vi.fn();

vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast }),
  useOptionalAppUi: () => ({ showToast }),
  useConfirm: () => async () => true,
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/vendor/finances/refunds",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

import { VendorRefundsPanel } from "@/components/portal/vendor-refunds-panel";
import { VendorRefundModal } from "@/components/portal/vendor-refund-modal";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  showToast.mockClear();
});

const REFUNDS = [
  { id: "r1", status: "succeeded", grossCents: 5_000, feeShareCents: 150, netDebitCents: 4_850, reason: "Partial", createdAt: "2026-10-06T00:00:00.000Z", paymentLabel: "Patch drywall hole", managerLabel: "Test Manager" },
  { id: "r2", status: "pending", grossCents: 2_000, feeShareCents: 60, netDebitCents: 1_940, reason: "", createdAt: "2026-10-06T00:00:00.000Z", paymentLabel: "INV-1001", managerLabel: "Alder Property Co" },
  { id: "r3", status: "failed", grossCents: 1_000, feeShareCents: 30, netDebitCents: 970, reason: "", createdAt: "2026-10-05T00:00:00.000Z", paymentLabel: "INV-1000", managerLabel: "Alder Property Co" },
];

describe("VendorRefundsPanel", () => {
  it("lists pending, succeeded and failed refunds as shared rows with glyph facts", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ enabled: true, refunds: REFUNDS }) })) as unknown as typeof fetch);
    render(<VendorRefundsPanel basePath="/vendor" />);
    await waitFor(() => expect(screen.getAllByText("Patch drywall hole").length).toBeGreaterThan(0));
    expect(screen.getAllByText("Refunded").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Pending").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Failed").length).toBeGreaterThan(0);
    expect(screen.getAllByText("$50.00").length).toBeGreaterThan(0);
  });

  it("is an empty card, not a bare box, when there are no refunds", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ enabled: true, refunds: [] }) })) as unknown as typeof fetch);
    render(<VendorRefundsPanel basePath="/vendor" />);
    await waitFor(() => expect(screen.getByText("No refunds yet")).toBeTruthy());
  });

  it("source: shared row anatomy only - no Badge, no table, one ⋯", () => {
    const src = read("src/components/portal/vendor-refunds-panel.tsx");
    expect(src).toContain("PortalPropertyRecordRow");
    expect(src).toContain("VendorRowMenu");
    expect(src).toContain("PortalRecordListSurface");
    expect(src).not.toMatch(/<Badge\b|<table|<Button\b/);
    expect(src).toMatch(/export function VendorRefundsPanel\(props: \{/);
  });
});

describe("VendorRefundModal", () => {
  const PAYOUT = { id: "p1", workOrderId: null, invoiceId: "inv_1", amountCents: 20_500, stripeTransferId: null, status: "paid", failureReason: null, createdAt: "2026-10-06T00:00:00.000Z", platformFeeCents: 615, refundedGrossCents: 0, destination: "hold" };

  function stubModalFetch(cap: Record<string, unknown>) {
    const post = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, status: "pending" }) }));
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") return post(url, init);
      if (url === "/api/vendor/payouts") return { ok: true, json: async () => ({ payouts: [PAYOUT] }) };
      return { ok: true, json: async () => ({ enabled: true, payoutId: "p1", amountCents: 20_500, platformFeeCents: 615, refundedGrossCents: 0, maxGrossCents: 20_500, refusal: null, ...cap }) };
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    return { post, fetchMock };
  }

  it("previews 'Manager gets back · fee returned · From your balance' and sends one stable key with gross + reason", async () => {
    const { post } = stubModalFetch({});
    render(<VendorRefundModal open onClose={vi.fn()} onDone={vi.fn()} initialPayoutId="p1" paymentLabel="Patch drywall hole · $205.00" />);
    const amount = await screen.findByDisplayValue("205.00");
    fireEvent.change(amount, { target: { value: "50.00" } });
    await waitFor(() => expect(screen.getByText("Manager gets back")).toBeTruthy());
    expect(screen.getByText("From your balance")).toBeTruthy();
    expect(screen.getByText("$48.50")).toBeTruthy();
    expect(screen.getByText("$1.50")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Refund \$50\.00/ }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const init = post.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toMatch(/^[A-Za-z0-9_-]{8,80}$/);
    expect(JSON.parse(String(init.body))).toEqual({ amountCents: 5_000, reason: "Full refund" });
  });

  it("an already-withdrawn payment shows the refusal and offers no refund", async () => {
    stubModalFetch({ maxGrossCents: 0, refusal: "withdrawn" });
    render(<VendorRefundModal open onClose={vi.fn()} onDone={vi.fn()} initialPayoutId="p1" />);
    await waitFor(() => expect(screen.getByText(/already been withdrawn/)).toBeTruthy());
    expect((screen.getByRole("button", { name: /Refund/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("never sends more than the server's cap", async () => {
    const { post } = stubModalFetch({ maxGrossCents: 10_000 });
    render(<VendorRefundModal open onClose={vi.fn()} onDone={vi.fn()} initialPayoutId="p1" />);
    const amount = await screen.findByDisplayValue("100.00");
    fireEvent.change(amount, { target: { value: "150.00" } });
    expect((screen.getByRole("button", { name: /Refund/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(post).not.toHaveBeenCalled();
  });
});
