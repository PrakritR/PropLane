// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast: vi.fn() }),
  useOptionalAppUi: () => null,
}));
vi.mock("@/components/stripe-connect-embedded", () => ({
  StripeConnectEmbedded: ({ component }: { component: string }) => (
    <div data-attr="stub-stripe-connect-embedded">{component}</div>
  ),
}));
vi.mock("@/lib/native/detect-native", () => ({ isNativeRuntimeSync: () => false }));

import { PortalPayoutsSettingsPage } from "@/components/portal/portal-payouts-settings-page";

const readyBalance = {
  currency: "usd",
  availableCents: 428_000,
  withdrawableCents: 428_000,
  heldCents: 0,
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

function stubFetch(balance: unknown, opts: { bankAccountsStatus?: number } = {}) {
  const bankAccountsStatus = opts.bankAccountsStatus ?? 404;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/payouts/balance")) {
        return new Response(JSON.stringify(balance), { status: 200 });
      }
      if (url.endsWith("/bank-accounts")) {
        return new Response(JSON.stringify({ error: "not found" }), { status: bankAccountsStatus });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PortalPayoutsSettingsPage — ready state", () => {
  beforeEach(() => stubFetch(readyBalance));

  it("renders Balance with the Available label, the amount, and an enabled Withdraw button", async () => {
    render(<PortalPayoutsSettingsPage portal="vendor" />);
    await screen.findByText("$4,280.00");
    expect(screen.getByText("Available")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Withdraw" })).not.toBeDisabled();
  });

  it("hides the Set up section once ready", async () => {
    render(<PortalPayoutsSettingsPage portal="vendor" />);
    await screen.findByText("$4,280.00");
    expect(screen.queryByText("Set up")).not.toBeInTheDocument();
    expect(screen.queryByText("Verify identity")).not.toBeInTheDocument();
  });

  it("falls back to a single bank row from the balance endpoint when the bank-accounts route 404s", async () => {
    render(<PortalPayoutsSettingsPage portal="vendor" />);
    await screen.findByText("$4,280.00");
    expect(screen.getByText("Bank accounts")).toBeInTheDocument();
    expect(screen.getByText("Chase", { exact: false })).toBeInTheDocument();
    expect(screen.getByText(/4421/)).toBeInTheDocument();
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
                { id: "ba_1", kind: "bank", label: "Chase Checking", last4: "1487", status: "verified", default: true },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({}), { status: 200 });
      }),
    );
    render(<PortalPayoutsSettingsPage portal="vendor" />);
    await screen.findByText("$4,280.00");
    await waitFor(() => expect(screen.getByText(/Chase Checking/)).toBeInTheDocument());
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
                { id: "ba_2", kind: "bank", label: "Chase Checking", last4: "1487", status: "verified", default: true },
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
    render(<PortalPayoutsSettingsPage portal="vendor" />);
    await screen.findByText("$4,280.00");
    fireEvent.click(screen.getByRole("button", { name: "Withdraw" }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm withdrawal" }));
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
    render(<PortalPayoutsSettingsPage portal="vendor" />);
    await screen.findByText("$4,280.00");
    fireEvent.click(screen.getByRole("button", { name: "Withdraw" }));
    expect(await screen.findByRole("button", { name: "Continue" })).toBeInTheDocument();
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

  it("shows the Set up rows and a disabled Withdraw button", async () => {
    render(<PortalPayoutsSettingsPage portal="vendor" />);
    await screen.findByText("Set up");
    expect(screen.getByText("Verify identity")).toBeInTheDocument();
    expect(screen.getByText("Add a bank account")).toBeInTheDocument();
    expect(screen.getByText("Ready to pay out")).toBeInTheDocument();
    expect(screen.getByText("After 1 and 2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Withdraw" })).toBeDisabled();
  });

  it("Verify falls back to the embedded onboarding modal when no renderVerifySheet is given", async () => {
    render(<PortalPayoutsSettingsPage portal="vendor" />);
    await screen.findByRole("button", { name: "Verify" });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect(await screen.findByText("account_onboarding")).toBeInTheDocument();
  });

  it("uses a supplied renderVerifySheet instead of the fallback modal", async () => {
    render(
      <PortalPayoutsSettingsPage
        portal="vendor"
        renderVerifySheet={({ open }) => (open ? <div data-attr="custom-verify-sheet">custom verify</div> : null)}
      />,
    );
    await screen.findByRole("button", { name: "Verify" });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect(await screen.findByText("custom verify")).toBeInTheDocument();
    expect(screen.queryByText("account_onboarding")).not.toBeInTheDocument();
  });
});
