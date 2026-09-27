// @vitest-environment jsdom
//
// C160 — the vendor Financials Income tab surfaces the same
// Available-balance + Withdraw affordance Settings → Payouts already has,
// reusing the same read/write routes rather than a new money path.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { AppUiProvider } from "@/components/providers/app-ui-provider";
import { VendorFinancesPanel } from "@/components/portal/vendor-finances-panel";

function renderPanel() {
  return render(
    <AppUiProvider>
      <VendorFinancesPanel tabId="income" />
    </AppUiProvider>,
  );
}

vi.mock("@/lib/demo/demo-session", () => ({
  isDemoModeActive: () => false,
  subscribeDemoPath: () => () => {},
  DEMO_MANAGER_USER_ID: "demo-manager",
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/vendor/financials/income",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

vi.mock("@/lib/vendor-payouts", () => ({
  fetchVendorPayoutsResult: async () => ({ ok: true, payouts: [] }),
}));

vi.mock("@/lib/manager-work-orders-storage", () => ({
  MANAGER_WORK_ORDERS_EVENT: "manager-work-orders",
  readVendorWorkOrderRows: () => [],
  syncManagerWorkOrdersFromServer: async () => {},
}));

const BALANCE = {
  currency: "usd",
  availableCents: 42_500,
  instantAvailableCents: 0,
  pendingCents: 0,
  onTheWayCents: 0,
  withdrawableCents: 42_500,
  bank: null,
  schedule: { interval: "manual", nextPayoutAt: null },
  setup: { identity: "done", bank: "done", ready: true },
  history: [],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("vendor Income balance card", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        if (String(url).includes("/api/vendor/payouts/balance")) {
          return { ok: true, status: 200, json: async () => BALANCE } as unknown as Response;
        }
        return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
      }),
    );
  });

  it("shows the available balance and an enabled Withdraw action", async () => {
    renderPanel();
    await waitFor(() => expect(document.querySelector('[data-attr="vendor-income-balance-card"]')).not.toBeNull());
    expect(document.querySelector('[data-attr="vendor-income-balance-available"]')?.textContent).toContain("425.00");
    const withdrawBtn = document.querySelector('[data-attr="vendor-income-balance-withdraw"]') as HTMLButtonElement | null;
    expect(withdrawBtn).not.toBeNull();
    expect(withdrawBtn?.disabled).toBe(false);
  });

  it("omits the card rather than erroring when the balance read fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        if (String(url).includes("/api/vendor/payouts/balance")) {
          return { ok: false, status: 403, json: async () => ({ error: "no" }) } as unknown as Response;
        }
        return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
      }),
    );
    renderPanel();
    // The empty-income card (rows are mocked empty) is a reliable settle
    // marker independent of the balance card's own load outcome.
    await waitFor(() => expect(document.querySelector('[data-attr="vendor-income-empty-add"]')).not.toBeNull());
    expect(document.querySelector('[data-attr="vendor-income-balance-card"]')).toBeNull();
  });
});
