// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast: vi.fn() }),
  useOptionalAppUi: () => null,
}));
vi.mock("@/components/stripe-connect-embedded", () => ({
  StripeConnectEmbedded: ({ component }: { component: string }) => (
    <div data-attr="stub-stripe-connect-embedded">{component}</div>
  ),
}));
vi.mock("@/components/portal/payout-bank-sheet", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/components/portal/payout-bank-sheet")>(),
  PayoutBankSheet: ({ open }: { open: boolean }) => (open ? <div data-attr="stub-bank-sheet">bank sheet</div> : null),
}));
vi.mock("@/lib/native/detect-native", () => ({ isNativeRuntimeSync: () => false }));

import { PortalPayoutsSettingsPage } from "@/components/portal/portal-payouts-settings-page";
import { resetSharedGets } from "@/lib/shared-get-cache";

const readyBalance = {
  currency: "usd",
  availableCents: 428_000,
  withdrawableCents: 428_000,
  heldCents: 0,
  releasePendingCents: 0,
  recoveryOutstandingCents: 0,
  recoveryReservedCents: 0,
  instantAvailableCents: 115_000,
  pendingCents: 240_000,
  onTheWayCents: 310_000,
  bank: {
    last4: "4421",
    bankName: "Chase",
    accountType: "checking",
    instantEligible: true,
    verifiedAt: "2026-09-12T00:00:00.000Z",
  },
  schedule: { interval: "weekly", nextPayoutAt: "2026-09-26T00:00:00.000Z" },
  setup: { identity: "done", bank: "done", ready: true },
  history: [],
};

const notReadyBalance = {
  ...readyBalance,
  bank: null,
  onTheWayCents: 0,
  setup: { identity: "needed", bank: "needed", ready: false },
};

function stubFetch(balance: unknown, opts: { bankAccountsStatus?: number; destinations?: unknown[] } = {}) {
  const bankAccountsStatus = opts.bankAccountsStatus ?? 200;
  const bankDestinations = opts.destinations ?? ((balance as typeof readyBalance).bank ? [
    { id: "ba_1", kind: "bank", label: "Chase", last4: "4421", status: "new", payable: true,
      instantEligible: false, default: true },
  ] : []);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/payouts/balance")) {
        return new Response(JSON.stringify(balance), { status: 200 });
      }
      if (url.endsWith("/bank-accounts")) {
        return new Response(JSON.stringify(bankAccountsStatus === 200 ? { destinations: bankDestinations } : { error: "not found" }), { status: bankAccountsStatus });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }),
  );
}

afterEach(() => {
  cleanup();
  resetSharedGets();
  vi.unstubAllGlobals();
});

describe("PortalPayoutsSettingsPage — ready state", () => {
  beforeEach(() => stubFetch(readyBalance));

  it("renders the provider withdrawable amount with an enabled Withdraw button", async () => {
    render(<PortalPayoutsSettingsPage portal="manager" />);
    await screen.findByText("$4,280.00");
    expect(screen.getByText("Available to withdraw")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Withdraw" })).not.toBeDisabled();
  });

  it("the vendor schedule row shows the withdrawable amount, never the held-inclusive available figure", async () => {
    stubFetch({ ...readyBalance, availableCents: 428_000, withdrawableCents: 100_000, heldCents: 328_000,
      schedule: { interval: "weekly", nextPayoutAt: "2026-09-26T00:00:00.000Z" } });
    render(<PortalPayoutsSettingsPage portal="vendor" />);
    const row = (await screen.findByText("Next payout")).closest("div")!.parentElement!;
    expect(row).toHaveTextContent("$1,000.00");
    expect(row).not.toHaveTextContent("$4,280.00");
  });

  it("hides the Set up section once ready", async () => {
    render(<PortalPayoutsSettingsPage portal="manager" />);
    await screen.findByText("$4,280.00");
    expect(screen.queryByText("Set up")).not.toBeInTheDocument();
    expect(screen.queryByText("Verify identity")).not.toBeInTheDocument();
  });

  it("fails closed when the bank-accounts route is unavailable", async () => {
    stubFetch(readyBalance, { bankAccountsStatus: 404 });
    render(<PortalPayoutsSettingsPage portal="manager" />);
    expect(await screen.findByText("Could not verify payout bank accounts.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Withdraw" })).not.toBeInTheDocument();
  });

  it("renders live bank-accounts rows (with a ⋯ menu) when the route is present", async () => {
    stubFetch(readyBalance, { bankAccountsStatus: 0 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/payouts/balance")) return new Response(JSON.stringify(readyBalance), { status: 200 });
        if (url.endsWith("/bank-accounts")) {
          // The real route (`GET .../bank-accounts`) answers
          // `{ destinations: [...] }`, never a bare array.
          return new Response(
            JSON.stringify({
              destinations: [
                { id: "ba_1", kind: "bank", label: "Chase Checking", last4: "1487", status: "new", payable: true, instantEligible: false, default: true },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({}), { status: 200 });
      }),
    );
    render(<PortalPayoutsSettingsPage portal="manager" />);
    await screen.findByText("$4,280.00");
    await waitFor(() => expect(screen.getAllByText(/Chase Checking/).length).toBeGreaterThan(0));
    expect(screen.getByRole("button", { name: /Actions for/ })).toBeInTheDocument();
  });

  it("passes the live destination's real id to the Withdraw sheet, so a real destinationId reaches create", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/payouts/balance")) return new Response(JSON.stringify(readyBalance), { status: 200 });
        if (url.endsWith("/bank-accounts")) {
          return new Response(
            JSON.stringify({
              destinations: [
                { id: "ba_2", kind: "bank", label: "Chase Checking", last4: "1487", status: "new", payable: true, instantEligible: false, default: true },
              ],
            }),
            { status: 200 },
          );
        }
        if (url.endsWith("/payouts/create")) {
          return new Response(
            JSON.stringify({ payoutId: "po_1", amountCents: 428_000, feeCents: 0, netCents: 428_000, method: "standard" }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({}), { status: 200 });
      }),
    );
    render(<PortalPayoutsSettingsPage portal="manager" />);
    await screen.findByText("$4,280.00");
    fireEvent.click(screen.getByRole("button", { name: "Withdraw" }));
    fireEvent.click(screen.getByRole("button", { name: /^Withdraw \$/ }));
    await waitFor(() => {
      const createCall = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.find(([input]) =>
        String(input).endsWith("/payouts/create"),
      );
      expect(createCall).toBeDefined();
      const [, init] = createCall!;
      expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({ destinationId: "ba_2" });
    });
  });

  it("opens the Withdraw sheet from the Balance section", async () => {
    render(<PortalPayoutsSettingsPage portal="manager" />);
    await screen.findByText("$4,280.00");
    fireEvent.click(screen.getByRole("button", { name: "Withdraw" }));
    expect(await screen.findByRole("button", { name: /^Withdraw \$/ })).toBeInTheDocument();
  });
});

describe("PortalPayoutsSettingsPage — not-ready state", () => {
  beforeEach(() => stubFetch(notReadyBalance));

  it("keeps Withdraw off when Available is only a platform hold", async () => {
    stubFetch({
      ...notReadyBalance,
      availableCents: 124_000,
      heldCents: 124_000,
      withdrawableCents: 0,
      availableNote: "Held on PropLane until a bank is connected",
    });
    render(<PortalPayoutsSettingsPage portal="manager" />);
    await screen.findByText("$1,240.00");
    expect(screen.getByText("Held on PropLane until a bank is connected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Withdraw" })).toBeDisabled();
  });

  it("shows the actual $105 held baseline as zero withdrawable without promising bank payout", async () => {
    stubFetch({ ...notReadyBalance, availableCents: 10_500, withdrawableCents: 0, heldCents: 10_500,
      pendingCents: 0, onTheWayCents: 0, releasePendingCents: 0 });
    render(<PortalPayoutsSettingsPage portal="manager" />);
    await screen.findByText("$105.00");
    expect(document.querySelector('[data-attr="payouts-settings-available"]')).toHaveTextContent("$0.00");
    expect(document.querySelector('[data-attr="payouts-settings-held"]')).toHaveTextContent("$105.00");
    expect(screen.getByRole("button", { name: "Withdraw" })).toBeDisabled();
  });

  it("keeps signed provider deficit and unrepaid owner recovery separate from cash", async () => {
    stubFetch({ ...notReadyBalance, withdrawableCents: -2_500, availableCents: 8_000,
      heldCents: 10_500, releasePendingCents: 1_500,
      recoveryOutstandingCents: 7_000, recoveryReservedCents: 1_500 });
    render(<PortalPayoutsSettingsPage portal="manager" />);
    await screen.findByText("Provider deficit");
    expect(document.querySelector('[data-attr="payouts-settings-provider-deficit"]')).toHaveTextContent("$25.00");
    expect(document.querySelector('[data-attr="payouts-settings-recovery-owed"]')).toHaveTextContent("$70.00");
    expect(document.querySelector('[data-attr="payouts-settings-recovery-reserved"]')).toHaveTextContent("$15.00");
    expect(document.querySelector('[data-attr="payouts-settings-release-pending"]')).toHaveTextContent("$15.00");
    expect(document.querySelector('[data-attr="payouts-settings-available"]')).toHaveTextContent("$0.00");
  });

  it("shows a held-source release separately from a bank payout", async () => {
    stubFetch({ ...readyBalance, history: [{
      id: "release_1", kind: "source_movement", amountCents: 10_000, feeCents: 0, netCents: 10_000,
      method: null, status: "paid", destinationLast4: null, createdAt: "2026-10-05T00:00:00.000Z",
      arrivalDate: null, initiatedInApp: false, failureMessage: null, serviceLabel: "Held payment released",
    }] });
    render(<PortalPayoutsSettingsPage portal="manager" />);
    // One title, one dated fact, one figure - the movement is never said twice.
    const source = await screen.findByText("Moved to Stripe");
    const row = source.closest("div")?.parentElement;
    expect(row).toHaveTextContent("$100.00");
    expect(row?.textContent).not.toMatch(/Moved to Stripe.*Moved/);
    expect(screen.queryByText("Held payment released")).not.toBeInTheDocument();
    expect(screen.queryByText(/Standard ·/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Receipt" })).not.toBeInTheDocument();
  });

  it("has no Set up checklist and no Verify identity step", async () => {
    render(<PortalPayoutsSettingsPage portal="manager" />);
    await screen.findByText("Bank accounts");
    expect(screen.queryByText("Set up")).not.toBeInTheDocument();
    expect(screen.queryByText("Verify identity")).not.toBeInTheDocument();
    expect(screen.queryByText("Ready to pay out")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Withdraw" })).toBeDisabled();
  });

  it("the Bank accounts + never opens embedded onboarding and blocks (in-app identity flow) when the account cannot receive payouts yet", async () => {
    render(<PortalPayoutsSettingsPage portal="vendor" />);
    await screen.findByText("Bank accounts");
    fireEvent.click(screen.getByRole("button", { name: "Add a bank account" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/needs a Stripe sign-in outside PropLane/);
    expect(screen.queryByText("account_onboarding")).not.toBeInTheDocument();
  });
});

it("does not let an old portal balance replace the newly selected portal", async () => {
  let finishManagerRead!: (response: Response) => void;
  const oldManagerRead = new Promise<Response>((resolve) => { finishManagerRead = resolve; });
  const vendorBalance = { ...readyBalance, availableCents: 2_000, withdrawableCents: 2_000 };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/stripe/payouts/balance") return oldManagerRead;
    if (url === "/api/vendor/payouts/balance") return new Response(JSON.stringify({ ...vendorBalance, schedule: { interval: "weekly", nextPayoutAt: "2026-09-26T00:00:00.000Z" } }), { status: 200 });
    if (url.endsWith("/bank-accounts")) return new Response(JSON.stringify({ destinations: [
      { id: "ba_current", kind: "bank", label: "Current", last4: "1234", status: "new", payable: true, instantEligible: false, default: true },
    ] }), { status: 200 });
    if (url.endsWith("/proplane-balance")) return new Response(JSON.stringify({ enabled: false, availableCents: 0, pendingCents: 0, currency: "usd" }), { status: 200 });
    return new Response(JSON.stringify({ workspacePaymentSettings: {} }), { status: 200 });
  }));
  const view = render(<PortalPayoutsSettingsPage portal="manager" />);
  await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/stripe/payouts/balance", expect.anything()));
  view.rerender(<PortalPayoutsSettingsPage portal="vendor" />);
  await screen.findByText(/\$20\.00/);
  await act(async () => { finishManagerRead(new Response(JSON.stringify(readyBalance), { status: 200 })); });
  expect(screen.getByText(/\$20\.00/)).toBeInTheDocument();
  expect(screen.queryByText("$4,280.00")).not.toBeInTheDocument();
});

describe("PortalPayoutsSettingsPage — vendor keeps only bank accounts + schedule", () => {
  beforeEach(() => stubFetch(readyBalance));

  it("links to Finances and offers no Withdraw, no payout history and no W-9 / fee section", async () => {
    render(<PortalPayoutsSettingsPage portal="vendor" />);
    await screen.findByText("Bank accounts");
    expect(screen.getByRole("link", { name: "Open Finances" })).toHaveAttribute("href", "/vendor/financials/balance");
    expect(screen.getByText("Schedule")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Withdraw" })).not.toBeInTheDocument();
    expect(screen.queryByText("History")).not.toBeInTheDocument();
    expect(screen.queryByText("W-9 on file")).not.toBeInTheDocument();
  });
});
