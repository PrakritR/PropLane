// @vitest-environment jsdom
//
// Vendor Finances, "PropLane balance" (owner-management): hidden when the vendor has no managed activity, tiles and
// statement from one read, Withdraw posts integer cents with a fresh client key, the server's error text is shown.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AppUiProvider } from "@/components/providers/app-ui-provider";
import { VendorManagedBalance, parseAmountToCents } from "@/components/portal/vendor-managed-balance";
import { resetSharedGets } from "@/lib/shared-get-cache";

const navigate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => navigate }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/vendor/financials/overview",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

const VIEW = {
  month: "2026-10",
  balance: { balanceCents: 30_000, availableCents: 21_050, pendingCents: 8_950, reserveCents: 0 },
  statement: {
    fromIso: "2026-10-01T07:00:00.000Z",
    toIso: "2026-11-01T07:00:00.000Z",
    beginningCents: 0,
    rows: [
      { id: "j1", date: "2026-10-03T18:00:00.000Z", kind: "bill", label: "Plumbing, 12 Pine St", amountCents: 25_000, href: "/vendor/jobs/w1" },
      { id: "j2", date: "2026-10-09T18:00:00.000Z", kind: "adjustment", label: "Correction", amountCents: -1_500 },
    ],
    totals: { rentGrossCents: 0, feeCents: 0, vendorChargesCents: 0, otherCents: 0, netCents: 23_500, withdrawalsCents: 0 },
    endingCents: 23_500,
  },
  withdrawals: [
    { id: "w1", amountCents: 5_000, status: "completed", createdAt: "2026-10-05T18:00:00.000Z", payoutPending: true },
    { id: "w2", amountCents: 1_000, status: "completed", createdAt: "2026-10-01T18:00:00.000Z", payoutPending: false },
  ],
  payoutReady: true,
};
const EMPTY = {
  month: "2026-10",
  balance: { balanceCents: 0, availableCents: 0, pendingCents: 0, reserveCents: 0 },
  statement: { fromIso: "", toIso: "", beginningCents: 0, rows: [], totals: { rentGrossCents: 0, feeCents: 0, vendorChargesCents: 0, otherCents: 0, netCents: 0, withdrawalsCents: 0 }, endingCents: 0 },
  withdrawals: [],
  payoutReady: null,
};

type Call = { url: string; init?: RequestInit };
let calls: Call[] = [];
function stub(opts: { read?: { status?: number; body: unknown }; withdraw?: { status: number; body: unknown } }) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, init });
      const res = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;
      if (u.includes("/withdraw")) return res(opts.withdraw?.status ?? 200, opts.withdraw?.body ?? { ok: true, withdrawalId: "x", payoutPending: false });
      return res(opts.read?.status ?? 200, opts.read?.body ?? VIEW);
    }),
  );
}

beforeEach(() => navigate.mockClear());
afterEach(() => {
  cleanup();
  resetSharedGets();
  vi.unstubAllGlobals();
});

const renderCard = () => render(<AppUiProvider><VendorManagedBalance basePath="/vendor" /></AppUiProvider>);
const q = (attr: string) => document.querySelector(`[data-attr="${attr}"]`) as HTMLElement | null;

describe("vendor PropLane balance", () => {
  it("renders nothing for a vendor with no managed activity", async () => {
    stub({ read: { body: EMPTY } });
    const { container } = renderCard();
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 20));
    expect(container.querySelector("[data-attr^='vendor-managed']")).toBeNull();
  });

  it("renders nothing, quietly, when the read fails or is malformed", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    stub({ read: { status: 500, body: { error: "boom" } } });
    const failed = renderCard();
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 20));
    expect(failed.container.querySelector("[data-attr^='vendor-managed']")).toBeNull();
    failed.unmount();
    resetSharedGets();
    stub({ read: { body: {} } });
    const malformed = renderCard();
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 20));
    expect(malformed.container.querySelector("[data-attr^='vendor-managed']")).toBeNull();
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("shows Balance / Available / Pending tiles, the statement and the withdrawals from the fixture", async () => {
    stub({});
    renderCard();
    await waitFor(() => expect(q("vendor-managed-balance")).toBeTruthy());
    expect(q("vendor-managed-balance-total")?.textContent).toBe("$300.00");
    expect(q("vendor-managed-balance-available")?.textContent).toBe("$210.50");
    expect(q("vendor-managed-balance-pending")?.textContent).toBe("$89.50");
    expect(screen.getByText("Plumbing, 12 Pine St")).toBeTruthy();
    expect(screen.getByText("$250.00")).toBeTruthy();
    expect(screen.getByText("-$15.00")).toBeTruthy();
    expect(screen.getByText("Bank payout is being set up")).toBeTruthy();
    expect(document.querySelectorAll("[data-attr='vendor-managed-withdrawal-row']")).toHaveLength(2);
    expect(q("vendor-managed-month-label")?.textContent).toBe("Oct 2026");
    expect((q("vendor-managed-month-next") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText("Plumbing, 12 Pine St"));
    expect(navigate).toHaveBeenCalledWith("/vendor/jobs/w1");
  });

  it("loads the previous month through the month parameter", async () => {
    stub({});
    renderCard();
    await waitFor(() => expect(q("vendor-managed-month-prev")).toBeTruthy());
    fireEvent.click(q("vendor-managed-month-prev")!);
    await waitFor(() => expect(calls.some((c) => c.url === "/api/vendor/managed-finance?month=2026-09")).toBe(true));
  });

  it("withdraws the prefilled available amount in cents with a client key", async () => {
    stub({});
    renderCard();
    await waitFor(() => expect(q("vendor-managed-withdraw")).toBeTruthy());
    fireEvent.click(q("vendor-managed-withdraw")!);
    const input = await waitFor(() => {
      const el = q("vendor-managed-withdraw-amount") as HTMLInputElement | null;
      expect(el).toBeTruthy();
      return el!;
    });
    expect(input.value).toBe("210.50");
    fireEvent.click(q("vendor-managed-withdraw-confirm")!);
    await waitFor(() => expect(calls.some((c) => c.url === "/api/vendor/managed-finance/withdraw")).toBe(true));
    const post = calls.find((c) => c.url === "/api/vendor/managed-finance/withdraw")!;
    expect(post.init?.method).toBe("POST");
    const body = JSON.parse(String(post.init?.body)) as { amountCents: number; clientKey: string };
    expect(body.amountCents).toBe(21_050);
    expect(body.clientKey).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("uses a fresh client key for each opened pop-up and parses typed amounts to cents", async () => {
    stub({ withdraw: { status: 402, body: { error: "Set up payouts first.", code: "PAYOUTS_NOT_READY" } } });
    renderCard();
    await waitFor(() => expect(q("vendor-managed-withdraw")).toBeTruthy());
    const keys: string[] = [];
    for (const typed of ["12.5", "1,000"]) {
      fireEvent.click(q("vendor-managed-withdraw")!);
      const input = (await waitFor(() => {
        const el = q("vendor-managed-withdraw-amount") as HTMLInputElement | null;
        expect(el).toBeTruthy();
        return el!;
      })) as HTMLInputElement;
      fireEvent.change(input, { target: { value: typed } });
      if (typed === "12.5") {
        fireEvent.click(q("vendor-managed-withdraw-confirm")!);
        await waitFor(() => expect(q("vendor-managed-withdraw-error")).toBeTruthy());
        const post = calls.filter((c) => c.url.endsWith("/withdraw")).at(-1)!;
        const body = JSON.parse(String(post.init?.body)) as { amountCents: number; clientKey: string };
        expect(body.amountCents).toBe(1_250);
        keys.push(body.clientKey);
        fireEvent.click(screen.getByLabelText("Close"));
        await waitFor(() => expect(q("vendor-managed-withdraw-amount")).toBeNull());
      } else {
        // $1,000 is more than the $210.50 available: the commit stays disabled and nothing is posted.
        expect((q("vendor-managed-withdraw-confirm") as HTMLButtonElement).disabled).toBe(true);
      }
    }
    expect(keys[0]).toBeTruthy();
    expect(parseAmountToCents("12.5")).toBe(1_250);
    expect(parseAmountToCents("$1,000")).toBe(100_000);
    expect(parseAmountToCents("0.07")).toBe(7);
    expect(parseAmountToCents("1.234")).toBeNaN();
    expect(parseAmountToCents("abc")).toBeNaN();
  });

  it("shows the server error and a payout-setup link when payouts are not ready", async () => {
    stub({ withdraw: { status: 402, body: { error: "Finish setting up your payout account first.", code: "PAYOUTS_NOT_READY" } } });
    renderCard();
    await waitFor(() => expect(q("vendor-managed-withdraw")).toBeTruthy());
    fireEvent.click(q("vendor-managed-withdraw")!);
    await waitFor(() => expect(q("vendor-managed-withdraw-confirm")).toBeTruthy());
    fireEvent.click(q("vendor-managed-withdraw-confirm")!);
    await waitFor(() => expect(screen.getByText("Finish setting up your payout account first.")).toBeTruthy());
    expect(q("vendor-managed-withdraw-setup")?.getAttribute("href")).toBe("/vendor/profile?tab=payouts");
  });

  it("shows a plain server error without the setup link", async () => {
    stub({ withdraw: { status: 409, body: { error: "Another withdrawal is already in progress." } } });
    renderCard();
    await waitFor(() => expect(q("vendor-managed-withdraw")).toBeTruthy());
    fireEvent.click(q("vendor-managed-withdraw")!);
    await waitFor(() => expect(q("vendor-managed-withdraw-confirm")).toBeTruthy());
    fireEvent.click(q("vendor-managed-withdraw-confirm")!);
    await waitFor(() => expect(screen.getByText("Another withdrawal is already in progress.")).toBeTruthy());
    expect(q("vendor-managed-withdraw-setup")).toBeNull();
  });
});
