// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/vendor/financials/payouts",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast: vi.fn() }),
  useOptionalAppUi: () => null,
}));
vi.mock("@/components/stripe-connect-embedded", () => ({
  StripeConnectEmbedded: ({ component }: { component: string }) => (
    <div data-attr="stub-stripe-connect-embedded">{component}</div>
  ),
}));

import { PortalPayoutsPanel } from "@/components/portal/portal-payouts-panel";

function tapOption(target: Element | Node) {
  fireEvent.pointerDown(target, { pointerId: 1, clientX: 10, clientY: 10 });
  fireEvent.pointerUp(target, { pointerId: 1, clientX: 10, clientY: 10 });
}

const readyBalance = {
  currency: "usd",
  availableCents: 428_000,
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
  history: [
    {
      id: "po_1",
      amountCents: 310_000,
      feeCents: 0,
      netCents: 310_000,
      method: "standard",
      status: "paid",
      destinationLast4: "4421",
      createdAt: "2026-09-18T00:00:00.000Z",
      arrivalDate: "2026-09-20T00:00:00.000Z",
      initiatedInApp: true,
      failureMessage: null,
      serviceLabel: null,
    },
    {
      id: "po_2",
      amountCents: 178_200,
      feeCents: 1_800,
      netCents: 176_400,
      method: "instant",
      status: "paid",
      destinationLast4: "4421",
      createdAt: "2026-09-12T16:12:00.000Z",
      arrivalDate: "2026-09-12T16:41:00.000Z",
      initiatedInApp: true,
      failureMessage: null,
      serviceLabel: null,
    },
    {
      id: "po_3",
      amountCents: 205_000,
      feeCents: 0,
      netCents: 205_000,
      method: "standard",
      status: "returned",
      destinationLast4: "4421",
      createdAt: "2026-09-04T00:00:00.000Z",
      arrivalDate: "2026-09-08T00:00:00.000Z",
      initiatedInApp: true,
      failureMessage: null,
      serviceLabel: null,
    },
  ],
};

function stubBalanceFetch(balance: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/payouts/balance")) {
        return new Response(JSON.stringify(balance), { status: 200 });
      }
      if (url.endsWith("/payouts/schedule") && init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { interval: string };
        return new Response(JSON.stringify({ interval: body.interval, nextPayoutAt: "2026-09-27T00:00:00.000Z" }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PortalPayoutsPanel — ready state", () => {
  beforeEach(() => stubBalanceFetch(readyBalance));

  it("renders the available figure, the two balance facts, and exactly one Pay out button", async () => {
    render(<PortalPayoutsPanel portal="vendor" />);
    await screen.findByText("$4,280.00");
    expect(screen.getByText(/On the way \$3,100\.00/)).toBeInTheDocument();
    expect(screen.getByText(/Clearing \$2,400\.00/)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Pay out" })).toHaveLength(1);
  });

  it("renders the history rows, including a returned payout's wording in place of a status pill", async () => {
    render(<PortalPayoutsPanel portal="vendor" />);
    await screen.findByText("$3,100.00");
    expect(screen.getByText("$1,782.00")).toBeInTheDocument();
    expect(screen.getByText("$2,050.00")).toBeInTheDocument();
    expect(screen.getByText(/Returned by the bank .* back in Available/)).toBeInTheDocument();
  });

  it("search narrows the history to matching rows", async () => {
    render(<PortalPayoutsPanel portal="vendor" />);
    await screen.findByText("$3,100.00");
    fireEvent.change(screen.getByPlaceholderText("Search payouts"), { target: { value: "instant" } });
    expect(screen.getByText("$1,782.00")).toBeInTheDocument();
    expect(screen.queryByText("$3,100.00")).not.toBeInTheDocument();
    expect(screen.queryByText("$2,050.00")).not.toBeInTheDocument();
  });

  it("changing the schedule PUTs the new interval", async () => {
    render(<PortalPayoutsPanel portal="vendor" />);
    await screen.findByText("$4,280.00");
    fireEvent.click(screen.getByRole("button", { name: "Automatic payout", expanded: false }));
    const listbox = screen.getByRole("listbox");
    tapOption(within(listbox).getByText("Every day"));
    await waitFor(() => {
      const putCall = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === "PUT",
      );
      expect(putCall).toBeTruthy();
      expect(JSON.parse(String((putCall![1] as RequestInit).body))).toEqual({ interval: "daily" });
    });
  });
});

describe("PortalPayoutsPanel — Retry routes through the confirmation sheet", () => {
  const failedBalance = {
    ...readyBalance,
    history: [
      {
        id: "po_failed",
        amountCents: 50_000,
        feeCents: 500,
        netCents: 49_500,
        method: "instant",
        status: "failed",
        destinationLast4: "4421",
        createdAt: "2026-09-10T00:00:00.000Z",
        arrivalDate: null,
        initiatedInApp: true,
        failureMessage: "Bank declined.",
        serviceLabel: null,
      },
    ],
  };

  beforeEach(() => stubBalanceFetch(failedBalance));

  it("Retry opens the Pay out sheet prefilled with the failed row's amount and method — never a one-click POST", async () => {
    render(<PortalPayoutsPanel portal="vendor" />);
    await screen.findByText("$500.00");
    // The record row renders its trailing ⋯ menu once per responsive
    // breakpoint (mobile + desktop, both present in jsdom) — take the first.
    fireEvent.keyDown(
      screen.getAllByRole("button", { name: /Actions for Instant payout of \$500\.00/ })[0]!,
      { key: "ArrowDown" },
    );
    const retryItem = await screen.findByRole("menuitem", { name: "Retry" });
    fireEvent.click(retryItem);

    // The sheet opens with the ORIGINAL amount/method prefilled, not fired immediately.
    const continueBtn = await screen.findByRole("button", { name: "Continue" });
    expect(screen.getByLabelText("Amount")).toHaveValue("500.00");
    expect(
      (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.some(
        ([, init]) => (init as RequestInit | undefined)?.method === "POST",
      ),
    ).toBe(false);

    // Continue → review step; Confirm withdrawal is what actually sends the request.
    fireEvent.click(continueBtn);
    const submit = await screen.findByRole("button", { name: "Confirm withdrawal" });
    fireEvent.click(submit);
    await waitFor(() => {
      const postCall = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === "POST",
      );
      expect(postCall).toBeTruthy();
      expect(JSON.parse(String((postCall![1] as RequestInit).body))).toEqual({ amountCents: 50_000, method: "instant" });
    });
  });
});

describe("PortalPayoutsPanel — Receipt only opens an https URL", () => {
  const receiptBalance = {
    ...readyBalance,
    history: [
      {
        id: "po_receipt",
        amountCents: 12_000,
        feeCents: 0,
        netCents: 12_000,
        method: "standard",
        status: "paid",
        destinationLast4: "4421",
        createdAt: "2026-09-01T00:00:00.000Z",
        arrivalDate: "2026-09-02T00:00:00.000Z",
        initiatedInApp: true,
        failureMessage: null,
        serviceLabel: null,
        receiptUrl: "javascript:alert(1)",
      },
    ],
  };

  beforeEach(() => stubBalanceFetch(receiptBalance));

  it("never calls window.open for a non-https receiptUrl", async () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<PortalPayoutsPanel portal="vendor" />);
    await screen.findByText("$120.00");
    fireEvent.keyDown(
      screen.getAllByRole("button", { name: /Actions for Standard payout of \$120\.00/ })[0]!,
      { key: "ArrowDown" },
    );
    const receiptItem = await screen.findByRole("menuitem", { name: "Receipt" });
    fireEvent.click(receiptItem);
    expect(openSpy).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });
});

describe("PortalPayoutsPanel — not-ready state", () => {
  it("renders the setup card instead of the balance card", async () => {
    stubBalanceFetch({
      ...readyBalance,
      bank: null,
      setup: { identity: "needed", bank: "needed", ready: false },
    });
    render(<PortalPayoutsPanel portal="vendor" />);
    await screen.findByText("Set up payouts");
    expect(screen.getByText("Verify identity")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Link bank" })).toBeInTheDocument();
    expect(screen.queryByText("Available now")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pay out" })).not.toBeInTheDocument();
  });
});

describe("PortalPayoutsPanel draws no pills", () => {
  it("has no Badge or status chip in its own source", () => {
    const source = readFileSync(
      join(process.cwd(), "src/components/portal/portal-payouts-panel.tsx"),
      "utf8",
    );
    expect(source).not.toMatch(/<Badge\b/);
    expect(source).not.toMatch(/PortalRowStatusChip/);
  });
});
