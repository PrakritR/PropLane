// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@stripe/stripe-js", () => ({ loadStripe: () => Promise.resolve({}) }));
vi.mock("@/components/portal/plaid-link-button", () => ({
  PlaidLinkLauncher: ({
    children,
    onSuccess,
  }: {
    children: (a: { start: () => Promise<void>; busy: boolean }) => React.ReactNode;
    onSuccess: (r: { publicToken: string; accountId: string | null }) => Promise<void> | void;
  }) => children({ start: async () => { await onSuccess({ publicToken: "public-sandbox-x", accountId: "acc-1" }); }, busy: false }),
}));

import { ResidentBankAccountForm } from "@/components/portal/resident-bank-account-form";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const LINKED_ITEM = { id: "row-1", institutionName: "First Platypus Bank", accountName: "Plaid Checking", accountMask: "0000" };

function stubFetch(plaidEnabled: boolean) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).startsWith("/api/plaid/status")) return new Response(JSON.stringify({ enabled: plaidEnabled, items: [] }), { status: 200 });
    if (String(input).startsWith("/api/resident/plaid/exchange")) return new Response(JSON.stringify({ item: LINKED_ITEM }), { status: 200 });
    if (String(input).startsWith("/api/stripe/resident-plaid-bank")) return new Response(JSON.stringify({ bankStatus: "paid", paid: true }), { status: 200 });
    return new Response(JSON.stringify({ bankStatus: "entry" }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const payPosts = (fetchMock: ReturnType<typeof stubFetch>) =>
  fetchMock.mock.calls.filter(([input]) => String(input).startsWith("/api/stripe/resident-plaid-bank"));

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

  it("asks for the authorization the path really takes: this debit plus saving the bank", async () => {
    stubFetch(true);
    render(<ResidentBankAccountForm kind="payment" intentId="pi_1" clientSecret="s" amountCents={1234} />);
    fireEvent.click(await screen.findByRole("button", { name: "Log in to your bank" }));
    const consent = await screen.findByText(/debit this bank account \$12\.34/);
    expect(consent.textContent).toContain("save it to my account for payments I approve");
    expect(consent.textContent).toContain("recurring autopay only if I separately enable it");
    expect(consent.textContent).not.toContain("once for");
  });

  it("refuses to debit a linked bank on an amount it cannot show", async () => {
    const fetchMock = stubFetch(true);
    render(<ResidentBankAccountForm kind="payment" intentId="pi_1" clientSecret="s" />);
    fireEvent.click(await screen.findByRole("button", { name: "Log in to your bank" }));
    fireEvent.click(await screen.findByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Pay $0.00" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Payment amount needs review.");
    expect(payPosts(fetchMock)).toHaveLength(0);
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
