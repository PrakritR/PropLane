// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@stripe/stripe-js", () => ({ loadStripe: () => Promise.resolve({}) }));
vi.mock("@/components/portal/plaid-link-button", () => ({
  PlaidLinkLauncher: ({ children }: { children: (a: { start: () => Promise<void>; busy: boolean }) => React.ReactNode }) =>
    children({ start: async () => {}, busy: false }),
}));

import { ResidentBankAccountForm } from "@/components/portal/resident-bank-account-form";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function stubFetch(plaidEnabled: boolean) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).startsWith("/api/plaid/status")) return new Response(JSON.stringify({ enabled: plaidEnabled, items: [] }), { status: 200 });
    return new Response(JSON.stringify({ bankStatus: "entry" }), { status: 200 });
  }));
}

describe("resident bank form with Plaid", () => {
  it("leaves the typed path unchanged when Plaid is disabled", async () => {
    stubFetch(false);
    render(<ResidentBankAccountForm kind="payment" intentId="pi_1" clientSecret="s" amountCents={1234} />);
    expect(await screen.findByRole("button", { name: "Pay from bank" })).toBeDisabled();
    expect(screen.getByText(/debit this bank account once for \$12\.34/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Log in to your bank" })).not.toBeInTheDocument();
  });

  it("offers Log in to your bank first and falls back to typed numbers", async () => {
    stubFetch(true);
    render(<ResidentBankAccountForm kind="payment" intentId="pi_1" clientSecret="s" amountCents={1234} />);
    expect(await screen.findByRole("button", { name: "Log in to your bank" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pay from bank" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Enter numbers instead" }));
    expect(await screen.findByRole("button", { name: "Pay from bank" })).toBeInTheDocument();
    expect(screen.getByLabelText("Routing number")).toBeInTheDocument();
  });

  it("never offers Plaid on a saved-bank setup or a phone-bound link", async () => {
    stubFetch(true);
    render(<ResidentBankAccountForm kind="setup" intentId="seti_1" clientSecret="s" />);
    expect(await screen.findByRole("button", { name: "Save bank account" })).toBeInTheDocument();
    cleanup();
    render(<ResidentBankAccountForm kind="payment" intentId="pi_1" clientSecret="s" amountCents={500} endpoint="/api/l/tok/bank-payment" />);
    expect(await screen.findByRole("button", { name: "Pay from bank" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Log in to your bank" })).not.toBeInTheDocument();
  });
});
