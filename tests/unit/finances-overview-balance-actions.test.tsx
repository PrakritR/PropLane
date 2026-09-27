// @vitest-environment jsdom
/**
 * C255: "Withdraw" must never sit visually equal to "Pay vendors" /
 * "Plan & credit" — the two balance-SPENDING cards get equal-weight cards,
 * Withdraw sits below them in a lighter, unbordered row (the
 * `ProplaneBalanceCard variant="subordinate"` case). The whole section stays
 * dark until BOTH the PropLane balance and WORKSPACE_CONNECT_ENABLED are on.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast: vi.fn() }),
}));
vi.mock("@/lib/household-charges", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/household-charges")>()),
  syncHouseholdChargesFromServer: vi.fn(async () => undefined),
  readChargesForManager: vi.fn(() => []),
}));
vi.mock("@/lib/manager-outgoing-payments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/manager-outgoing-payments")>()),
  syncManagerOutgoingExpensesFromServer: vi.fn(async () => undefined),
  readManagerOutgoingExpenses: vi.fn(() => []),
}));

import { ManagerFinancesOverview } from "@/components/portal/finances/finances-overview";

function mockFetch(eligible: boolean) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/portal/proplane-balance") {
        return Response.json({
          enabled: eligible,
          workspaceConnectEnabled: eligible,
          availableCents: 12_300,
          pendingCents: 0,
          currency: "usd",
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderPage() {
  return render(
    <ManagerFinancesOverview userId="mgr-1" ready propertyId="" period="month" basePath="/portal" propertyOptions={[]} />,
  );
}

describe("Finances overview — balance actions (C255)", () => {
  it("stays dark (no Pay vendors / Plan & credit / Withdraw section) until eligible", async () => {
    mockFetch(false);
    renderPage();

    await waitFor(() => expect(screen.getByText("Net operating income")).toBeTruthy());
    expect(screen.queryByText("Pay vendors")).toBeNull();
    expect(screen.queryByText("Plan & credit")).toBeNull();
    expect(document.querySelector('[data-attr="finances-balance-actions"]')).toBeNull();
  });

  it("shows Pay vendors and Plan & credit as equal-weight cards once eligible", async () => {
    mockFetch(true);
    renderPage();

    await waitFor(() => expect(screen.getByText("Pay vendors")).toBeTruthy());
    const payVendors = document.querySelector('[data-attr="finances-balance-action-pay-vendors"]');
    const planCredit = document.querySelector('[data-attr="finances-balance-action-plan-credit"]');
    expect(payVendors?.className).toContain("border");
    expect(payVendors?.className).toContain("shadow-sm");
    // Same card treatment — literally the same class string on both.
    expect(payVendors?.className).toBe(planCredit?.className);
  });

  it("renders Withdraw in the lighter, unbordered subordinate form — never a third same-weight card", async () => {
    mockFetch(true);
    renderPage();

    await waitFor(() => expect(document.querySelector('[data-attr="finances-balance-action-withdraw"]')).toBeTruthy());
    const withdrawWrap = document.querySelector('[data-attr="finances-balance-action-withdraw"]');
    expect(withdrawWrap).toBeTruthy();
    // The subordinate row, not the full bordered/shadowed card — the nested
    // ProplaneBalanceCard has its own independent balance read to resolve first.
    await waitFor(() =>
      expect(document.querySelector('[data-attr="proplane-balance-card-subordinate"]')).toBeTruthy(),
    );
    expect(document.querySelector('[data-attr="proplane-balance-card"]')).toBeNull();
    expect(withdrawWrap?.className).not.toContain("shadow-sm");
    expect(withdrawWrap?.className).not.toContain("border-border");
  });
});
