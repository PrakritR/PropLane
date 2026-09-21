// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

/**
 * The sheet must never send a raw routing/account/card number to the server
 * — only a Stripe.js token id or a Financial Connections account id. These
 * tests stub Stripe.js itself (jsdom cannot mount real Stripe Elements) and
 * assert on exactly what crosses the wire in each of the three modes.
 */

vi.mock("@/components/ui/modal", () => ({
  Modal: ({ open, children, title, footer }: { open: boolean; children: ReactNode; title: ReactNode; footer?: ReactNode }) =>
    open ? (
      <div role="dialog" aria-label={String(title)}>
        {children}
        {footer}
      </div>
    ) : null,
  ModalFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

// `payout-bank-sheet.tsx` calls `loadStripe(...)` as a module-level side
// effect, and ES module imports evaluate before any other top-level code in
// this file — so `fakeStripe`/`fakeElements` must exist before the mocked
// imports run, not just before the mock factories are (hoisted) declared.
// `vi.hoisted` is Vitest's escape hatch for exactly this ordering.
const { fakeStripe, fakeElements } = vi.hoisted(() => ({
  fakeStripe: {
    createToken: vi.fn(),
    collectFinancialConnectionsAccounts: vi.fn(),
  },
  fakeElements: {
    getElement: vi.fn(() => ({ __cardElementMarker: true })),
  },
}));

vi.mock("@stripe/stripe-js", () => ({
  loadStripe: () => Promise.resolve(fakeStripe),
}));

vi.mock("@stripe/react-stripe-js", () => ({
  Elements: ({ children }: { children: ReactNode }) => <>{children}</>,
  CardElement: () => <div data-attr="fake-card-element" />,
  useStripe: () => fakeStripe,
  useElements: () => fakeElements,
}));

import { PayoutBankSheet } from "@/components/portal/payout-bank-sheet";

type FetchCall = { url: string; body: unknown };
let fetchCalls: FetchCall[] = [];
let fetchResponses: Record<string, unknown> = {};

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      fetchCalls.push({ url, body });
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      const matchKey = Object.keys(fetchResponses).find((k) => path.endsWith(k));
      const data = matchKey ? fetchResponses[matchKey] : { error: "unexpected fetch" };
      return {
        ok: !(data as { error?: string })?.error,
        json: async () => data,
      } as Response;
    }),
  );
}

beforeEach(() => {
  fetchCalls = [];
  fetchResponses = {};
  fakeStripe.createToken.mockReset();
  fakeStripe.collectFinancialConnectionsAccounts.mockReset();
  fakeElements.getElement.mockReturnValue({ __cardElementMarker: true });
  stubFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PayoutBankSheet", () => {
  it("renders all three modes with Link instantly selected by default", () => {
    render(<PayoutBankSheet open apiBase="/api/stripe/connect" onClose={vi.fn()} onAdded={vi.fn()} />);
    expect(screen.getByText("Link instantly")).toBeInTheDocument();
    expect(screen.getByText("Enter routing and account number")).toBeInTheDocument();
    expect(screen.getByText("Debit card for instant payouts")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Link instantly/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("manual mode: posts only the bank token — never the typed routing/account digits", async () => {
    fakeStripe.createToken.mockResolvedValue({ token: { id: "btok_abc123" } });
    fetchResponses["/bank-accounts"] = {
      destination: { id: "ba_1", kind: "bank", label: "Chase", last4: "4321", status: "verifying", default: true },
    };
    const onAdded = vi.fn();
    const onClose = vi.fn();
    render(<PayoutBankSheet open apiBase="/api/stripe/connect" onClose={onClose} onAdded={onAdded} />);

    fireEvent.click(screen.getByText("Enter routing and account number"));
    fireEvent.change(screen.getByLabelText("Account holder"), { target: { value: "Prakrit Ramachandran" } });
    fireEvent.change(screen.getByLabelText("Routing number"), { target: { value: "325070760" } });
    fireEvent.change(screen.getByLabelText("Account number"), { target: { value: "0009876543210" } });

    fireEvent.click(screen.getByRole("button", { name: "Add account" }));

    await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
    expect(fakeStripe.createToken).toHaveBeenCalledWith(
      "bank_account",
      expect.objectContaining({ routing_number: "325070760", account_number: "0009876543210" }),
    );

    const post = fetchCalls.find((c) => c.url.endsWith("/bank-accounts"));
    expect(post?.body).toEqual({ token: "btok_abc123" });
    const serializedBody = JSON.stringify(post?.body);
    expect(serializedBody).not.toContain("325070760");
    expect(serializedBody).not.toContain("0009876543210");

    expect(onAdded).toHaveBeenCalledWith(expect.objectContaining({ id: "ba_1", kind: "bank" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("card mode: tokenizes the CardElement and posts only the resulting token", async () => {
    fakeStripe.createToken.mockResolvedValue({ token: { id: "tok_card123" } });
    fetchResponses["/bank-accounts"] = {
      destination: { id: "card_1", kind: "card", label: "Visa", last4: "4242", status: "verified", default: false },
    };
    const onAdded = vi.fn();
    render(<PayoutBankSheet open apiBase="/api/stripe/connect" onClose={vi.fn()} onAdded={onAdded} />);

    fireEvent.click(screen.getByText("Debit card for instant payouts"));
    fireEvent.click(screen.getByRole("button", { name: "Add account" }));

    await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
    expect(fakeStripe.createToken).toHaveBeenCalledWith({ __cardElementMarker: true });
    const post = fetchCalls.find((c) => c.url.endsWith("/bank-accounts"));
    expect(post?.body).toEqual({ token: "tok_card123" });
  });

  it("card mode surfaces the server's credit-card rejection", async () => {
    fakeStripe.createToken.mockResolvedValue({ token: { id: "tok_credit" } });
    fetchResponses["/bank-accounts"] = { error: "Add a debit card — credit cards can't receive instant payouts." };
    const onAdded = vi.fn();
    render(<PayoutBankSheet open apiBase="/api/stripe/connect" onClose={vi.fn()} onAdded={onAdded} />);

    fireEvent.click(screen.getByText("Debit card for instant payouts"));
    fireEvent.click(screen.getByRole("button", { name: "Add account" }));

    await waitFor(() =>
      expect(screen.getByText("Add a debit card — credit cards can't receive instant payouts.")).toBeInTheDocument(),
    );
    expect(onAdded).not.toHaveBeenCalled();
  });

  it("instant mode: opens Financial Connections, then attaches the linked account id", async () => {
    fetchResponses["/financial-connections/session"] = { clientSecret: "secret_1" };
    fetchResponses["/financial-connections/attach"] = {
      destination: { id: "ba_fc", kind: "bank", label: "Chase", last4: "1487", status: "verified", default: true },
    };
    fakeStripe.collectFinancialConnectionsAccounts.mockResolvedValue({
      financialConnectionsSession: { accounts: [{ id: "fca_999" }] },
    });
    const onAdded = vi.fn();
    render(<PayoutBankSheet open apiBase="/api/stripe/connect" onClose={vi.fn()} onAdded={onAdded} />);

    fireEvent.click(screen.getByRole("button", { name: "Add account" }));

    await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
    expect(fakeStripe.collectFinancialConnectionsAccounts).toHaveBeenCalledWith({ clientSecret: "secret_1" });
    const attach = fetchCalls.find((c) => c.url.endsWith("/financial-connections/attach"));
    expect(attach?.body).toEqual({ accountId: "fca_999" });
    expect(onAdded).toHaveBeenCalledWith(expect.objectContaining({ id: "ba_fc" }));
  });

  it("uses the given apiBase for every call (vendor twin)", async () => {
    fetchResponses["/financial-connections/session"] = { clientSecret: "secret_1" };
    fakeStripe.collectFinancialConnectionsAccounts.mockResolvedValue({ financialConnectionsSession: { accounts: [] } });
    render(<PayoutBankSheet open apiBase="/api/vendor/stripe-connect" onClose={vi.fn()} onAdded={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Add account" }));

    await waitFor(() => expect(fetchCalls.length).toBeGreaterThan(0));
    expect(fetchCalls[0]!.url).toContain("/api/vendor/stripe-connect/financial-connections/session");
  });
});
