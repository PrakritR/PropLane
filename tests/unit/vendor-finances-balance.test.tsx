// @vitest-environment jsdom
//
// Vendor Finances → Balance & payouts (vendor-banking-1006): one snapshot feeds
// every figure, the banner names the exact reason money cannot move, Bank and
// Withdraw are the only header icons, the payout history opens a detail page,
// and a disabled Withdraw always says why.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AppUiProvider } from "@/components/providers/app-ui-provider";
import { VendorFinancesPage, VendorWithdrawalDetail } from "@/components/portal/vendor-finances-balance";
import { resetSharedGets } from "@/lib/shared-get-cache";

const navigate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => navigate }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/vendor/financials/balance",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

const READY = {
  currency: "usd",
  availableCents: 42_500,
  instantAvailableCents: 42_500,
  pendingCents: 52_000,
  onTheWayCents: 18_000,
  withdrawableCents: 42_500,
  heldCents: 0,
  releasePendingCents: 0,
  recoveryOutstandingCents: 0,
  recoveryReservedCents: 0,
  bank: null,
  schedule: { interval: "manual", nextPayoutAt: null },
  setup: { identity: "done", bank: "done", ready: true },
  history: [
    { id: "po_1", amountCents: 40_000, feeCents: 0, netCents: 40_000, method: "standard", status: "paid", destinationLast4: "6789", createdAt: "2026-10-02T00:00:00.000Z", arrivalDate: "2026-10-04T00:00:00.000Z", initiatedInApp: true, failureMessage: null, serviceLabel: null },
    { id: "po_2", amountCents: 20_000, feeCents: 300, netCents: 19_700, method: "instant", status: "paid", destinationLast4: "4242", createdAt: "2026-09-28T00:00:00.000Z", arrivalDate: null, initiatedInApp: true, failureMessage: null, serviceLabel: null },
  ],
  feeBps: 300,
};
const BANKS = { destinations: [{ id: "ba_1", kind: "bank", label: "Chase", last4: "6789", status: "new", payable: true, instantEligible: false, default: true }] };

function stub(balance: unknown, opts: { balanceStatus?: number; banks?: unknown } = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      const u = String(url);
      const res = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;
      if (u.includes("/api/vendor/payouts/balance")) return res(opts.balanceStatus ?? 200, balance);
      if (u.includes("/bank-accounts")) return res(200, opts.banks ?? BANKS);
      return res(200, {});
    }),
  );
}

beforeEach(() => navigate.mockClear());
afterEach(() => {
  cleanup();
  resetSharedGets();
  vi.unstubAllGlobals();
});

const renderBalance = () => render(<AppUiProvider><VendorFinancesPage basePath="/vendor" tab="payouts" /></AppUiProvider>);
const q = (attr: string) => document.querySelector(`[data-attr="${attr}"]`) as HTMLElement | null;

describe("vendor Balance & payouts", () => {
  it("shows Available · Pending · Held · On the way from one snapshot, with Bank and Withdraw the only header icons", async () => {
    stub(READY);
    renderBalance();
    const card = await waitFor(() => {
      const el = q("vendor-balance-card");
      expect(el).toBeTruthy();
      return el!;
    });
    expect(q("vendor-balance-available")?.textContent).toBe("$425.00");
    expect(q("vendor-balance-pending")?.textContent).toBe("$520.00");
    expect(q("vendor-balance-held")?.textContent).toBe("$0.00");
    expect(q("vendor-balance-on-the-way")?.textContent).toBe("$180.00");
    expect(q("vendor-balance-owed")).toBeNull();
    expect(card.querySelectorAll("button")).toHaveLength(0);
    // Bank and Withdraw are the header band's only icons (the band also holds the Overview / Payouts / Refunds tabs).
    expect(q("vendor-balance-bank")).toBeTruthy();
    const icons = Array.from(document.querySelectorAll("[data-attr^='vendor-balance-']")).filter(
      (el) => el.tagName === "BUTTON" && ["vendor-balance-bank", "vendor-balance-withdraw"].includes(el.getAttribute("data-attr") ?? ""),
    );
    expect(icons.map((b) => b.getAttribute("aria-label"))).toEqual(["Bank", "Withdraw"]);
    expect(["overview", "payouts", "refunds"].every((id) => q(`vendor-finances-band-tab-${id}`))).toBe(true);
    expect((q("vendor-balance-withdraw") as HTMLButtonElement).disabled).toBe(false);
    expect(q("vendor-balance-banner")).toBeNull();
  });

  it("names the held reason and offers Add bank when money waits for a bank", async () => {
    stub({ ...READY, availableCents: 20_500, withdrawableCents: 0, heldCents: 20_500, setup: { identity: "done", bank: "needed", ready: false } }, { banks: { destinations: [] } });
    renderBalance();
    await waitFor(() => expect(q("vendor-balance-banner")).toBeTruthy());
    expect(q("vendor-balance-banner")?.textContent).toContain("Add a bank account to withdraw");
    expect(q("vendor-balance-banner")?.textContent).toContain("$205.00 is waiting for you");
    expect(q("vendor-balance-held")?.textContent).toBe("$205.00");
    expect(screen.getByText("Until you add a bank")).toBeTruthy();
    const withdraw = q("vendor-balance-withdraw") as HTMLButtonElement;
    expect(withdraw.disabled).toBe(true);
    expect(withdraw.getAttribute("aria-label")).toContain("Finish setting up payouts first");
  });

  it("shows Owed to PropLane only when something is owed", async () => {
    stub({ ...READY, recoveryOutstandingCents: 7_000 });
    renderBalance();
    await waitFor(() => expect(q("vendor-balance-owed")?.textContent).toBe("$70.00"));
  });

  it("a 409 from the balance read becomes a Reconnect banner, not a blank page", async () => {
    stub({ error: "Reconnect", needsRelink: true }, { balanceStatus: 409 });
    renderBalance();
    await waitFor(() => expect(q("vendor-balance-banner")?.textContent).toContain("Reconnect your Stripe account"));
    expect((q("vendor-balance-withdraw") as HTMLButtonElement).disabled).toBe(true);
  });

  it("a failed read is a real error with Retry", async () => {
    stub({ error: "boom" }, { balanceStatus: 500 });
    renderBalance();
    await waitFor(() => expect(screen.getByText("Could not load your balance.")).toBeTruthy());
    expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy();
  });

  it("lists payout history and a row opens its detail page", async () => {
    stub(READY);
    renderBalance();
    await waitFor(() => expect(document.querySelectorAll('[data-attr="vendor-payout-history-row"]')).toHaveLength(2));
    expect(screen.getByText("Instant payout")).toBeTruthy();
    fireEvent.click(screen.getByText("Standard payout"));
    expect(navigate).toHaveBeenCalledWith("/vendor/financials/balance/po_1");
  });

  it("the Withdraw sheet quotes the Instant fee from the one constant (no fee while none can be collected)", async () => {
    stub({ ...READY, feeBps: 300 }, { banks: { destinations: [{ id: "card_1", kind: "card", label: "Visa", last4: "4242", status: "new", payable: true, instantEligible: true, default: true }] } });
    renderBalance();
    await waitFor(() => expect((q("vendor-balance-withdraw") as HTMLButtonElement | null)?.disabled).toBe(false));
    fireEvent.click(q("vendor-balance-withdraw")!);
    expect(await screen.findByText(/Instant · No PropLane fee/)).toBeTruthy();
    expect(screen.queryByText(/Instant · 1% fee/)).toBeNull();
  });
});

describe("vendor withdrawal detail", () => {
  it("shows the payout's amounts and a Receipt action", async () => {
    stub(READY);
    render(<AppUiProvider><VendorWithdrawalDetail basePath="/vendor" withdrawalId="po_2" /></AppUiProvider>);
    await waitFor(() => expect(q("vendor-withdrawal-detail")).toBeTruthy());
    expect(screen.getByText("Instant payout fee")).toBeTruthy();
    expect(screen.getByText("Sent to your bank")).toBeTruthy();
    expect(q("vendor-withdrawal-receipt")).toBeTruthy();
  });

  it("says so when the payout is not in the snapshot", async () => {
    stub(READY);
    render(<AppUiProvider><VendorWithdrawalDetail basePath="/vendor" withdrawalId="nope" /></AppUiProvider>);
    await waitFor(() => expect(screen.getByText("Payout not found")).toBeTruthy());
  });
});
