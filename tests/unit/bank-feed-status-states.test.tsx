// @vitest-environment jsdom
/**
 * What the Bank rec panel offers for each feed state `/api/plaid/status` can answer with. A live feed reads
 * "Connected" with Sync now; a bank that wants a fresh sign-in gets the same-item re-auth; a transient read
 * failure gets Retry, not a relink. A feed the bank cut is not one of those states: the status route answers
 * only live items (`listPlaidItemsForOwner`, asserted in tests/unit/plaid/items.test.ts), so the panel has no
 * item at all and offers Connect bank.
 *
 * Oracle: what each `plaid_items.status` means at Plaid - `login_required` is a re-auth of the same item,
 * `error` is a transient read to retry - and the status route's own contract for a revoked item. Plausible
 * wrong behaviour this rejects: "Connected · synced …" with only Sync now for a state that is not live.
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

type FeedState = "active" | "login_required" | "error" | "none";

function stubFetch(status: FeedState) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/plaid/status")) {
        return new Response(
          JSON.stringify({
            enabled: true,
            items:
              status === "none"
                ? []
                : [
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

async function renderWith(status: FeedState) {
  stubFetch(status);
  render(<ManagerBankReconciliationPanel />);
  await waitFor(() => {
    expect(
      document.querySelector(
        '[data-attr="bank-feed-sync"], [data-attr="bank-feed-reconnect"], [data-attr="bank-feed-retry"], [data-attr="bank-feed-connect"]',
      ),
    ).toBeTruthy();
  });
}

describe("the bank feed status line", () => {
  it("says Connected and offers Sync now only for a live feed", async () => {
    await renderWith("active");
    expect(screen.getByText(/First Platypus Bank ••0000 · Connected/)).toBeTruthy();
    expect(document.querySelector('[data-attr="bank-feed-sync"]')).toBeTruthy();
  });

  // What a revoked feed looks like here: the route omits the item, so there is nothing to sync and the only
  // offer is a fresh link - never a "Connected" line against a stale sync time.
  it("offers Connect bank when the owner holds no live feed for the account", async () => {
    await renderWith("none");
    expect(screen.queryByText(/Connected/)).toBeNull();
    expect(document.querySelector('[data-attr="bank-feed-sync"]')).toBeNull();
    expect(document.querySelector('[data-attr="bank-feed-connect"]')).toBeTruthy();
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
    expect(document.querySelector('[data-attr="bank-feed-connect"]')).toBeNull();
  });
});
