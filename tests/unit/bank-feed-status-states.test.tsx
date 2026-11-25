// @vitest-environment jsdom
/**
 * A bank feed's status line is the manager's only signal that the feed is alive. Only an ACTIVE item may read
 * "Connected" and offer Sync now; a feed the bank has cut (`revoked`, written by the Plaid webhook on
 * USER_PERMISSION_REVOKED / USER_ACCOUNT_REVOKED) must say so and offer a reconnect, never a stale sync time.
 *
 * Oracle: the statuses `plaid_items.status` holds (`PlaidItemStatus`) and what each one means at Plaid -
 * `login_required` is a re-auth of the same item, `error` is a transient read to retry, `revoked` is consent
 * withdrawn at the bank, which needs a fresh Link (the one-live-feed index deliberately excludes a revoked row).
 * Plausible wrong behaviour this rejects: a non-active status falling through to the "Connected · synced …" row,
 * which tells a manager a dead feed is fine and offers only Sync now.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

// One stable identity: the panel's loaders are `useCallback`s keyed on `showToast`, so a fresh function per
// render would re-run their effects forever.
const appUi = vi.hoisted(() => ({ value: { showToast: () => {} }, confirm: () => () => Promise.resolve(true) }));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => appUi.value,
  useConfirm: () => appUi.confirm(),
}));
vi.mock("@/components/portal/plaid-link-button", () => ({
  PlaidLinkLauncher: ({
    children,
  }: {
    children: (a: { start: () => Promise<void>; busy: boolean }) => React.ReactNode;
  }) => children({ start: async () => {}, busy: false }),
}));

import { ManagerBankReconciliationPanel } from "@/components/portal/pro-bank-reconciliation-panel";

const ACCOUNT = {
  id: "acct-1",
  name: "Operating",
  accountType: "operating" as const,
  glAccountCode: "1000",
  lastFour: "4321",
  isActive: true,
};

function stubFetch(status: "active" | "login_required" | "error" | "revoked") {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/plaid/status")) {
        return new Response(
          JSON.stringify({
            enabled: true,
            items: [
              {
                id: "item-1",
                institutionName: "First Platypus Bank",
                accountMask: "0000",
                bankAccountId: ACCOUNT.id,
                status,
                lastSyncedAt: "2026-11-20T18:00:00.000Z",
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.startsWith("/api/manager-bank-accounts")) {
        return new Response(JSON.stringify({ accounts: [ACCOUNT] }), { status: 200 });
      }
      return new Response(JSON.stringify({ statements: [] }), { status: 200 });
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderWith(status: "active" | "login_required" | "error" | "revoked") {
  stubFetch(status);
  render(<ManagerBankReconciliationPanel />);
  await waitFor(() => {
    expect(document.querySelector('[data-attr="bank-feed-sync"], [data-attr="bank-feed-reconnect"], [data-attr="bank-feed-retry"], [data-attr="bank-feed-relink"]')).toBeTruthy();
  });
}

describe("the bank feed status line", () => {
  it("says Connected and offers Sync now only for a live feed", async () => {
    await renderWith("active");
    expect(screen.getByText(/First Platypus Bank ••0000 · Connected/)).toBeTruthy();
    expect(document.querySelector('[data-attr="bank-feed-sync"]')).toBeTruthy();
  });

  it("says the bank cut the feed and offers Reconnect when consent was revoked", async () => {
    await renderWith("revoked");
    expect(screen.getByText("First Platypus Bank ••0000 · Disconnected at your bank")).toBeTruthy();
    expect(screen.queryByText(/Connected/)).toBeNull();
    expect(document.querySelector('[data-attr="bank-feed-sync"]')).toBeNull();
    expect(document.querySelector('[data-attr="bank-feed-relink"]')).toBeTruthy();
  });

  it("offers the same-item re-auth when the bank wants a fresh sign-in", async () => {
    await renderWith("login_required");
    expect(screen.queryByText(/Connected/)).toBeNull();
    expect(document.querySelector('[data-attr="bank-feed-sync"]')).toBeNull();
    expect(document.querySelector('[data-attr="bank-feed-reconnect"]')).toBeTruthy();
  });

  it("offers a retry, not a relink, for a transient read failure", async () => {
    await renderWith("error");
    expect(screen.queryByText(/Connected/)).toBeNull();
    expect(document.querySelector('[data-attr="bank-feed-retry"]')).toBeTruthy();
    expect(document.querySelector('[data-attr="bank-feed-relink"]')).toBeNull();
  });
});
