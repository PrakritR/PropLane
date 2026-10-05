// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const state = vi.hoisted(() => ({ confirm: vi.fn() }));
vi.mock("@stripe/stripe-js", () => ({ loadStripe: () => Promise.resolve({
  confirmUsBankAccountPayment: (...args: unknown[]) => state.confirm(...args),
  confirmUsBankAccountSetup: (...args: unknown[]) => state.confirm(...args),
}) }));

import { ResidentBankAccountForm } from "@/components/portal/resident-bank-account-form";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); state.confirm.mockReset(); });

describe("resident in-app bank form", () => {
  it("resumes microdeposit verification from an exact stored PI after remount", async () => {
    const complete = vi.fn();
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return new Response(JSON.stringify({ bankStatus: "paid", paid: true }), { status: 200 });
      expect(String(input)).toContain("payment_intent_id=pi_exact");
      return new Response(JSON.stringify({ bankStatus: "verification" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetcher);
    render(<ResidentBankAccountForm kind="payment" intentId="pi_exact" clientSecret="pi_secret"
      amountCents={1234} initialStatus="verification" onComplete={complete} />);
    const code = await screen.findByPlaceholderText("SM1234");
    fireEvent.change(code, { target: { value: "SM1234" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify bank" }));
    await waitFor(() => expect(complete).toHaveBeenCalledOnce());
    expect(fetcher).toHaveBeenCalledWith("/api/stripe/resident-ach-payment", expect.objectContaining({
      method: "POST", body: JSON.stringify({ paymentIntentId: "pi_exact", descriptorCode: "SM1234" }),
    }));
    expect(state.confirm).not.toHaveBeenCalled();
  });

  it("shows the exact one-time debit mandate before enabling bank confirmation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ bankStatus: "entry" }), { status: 200 })));
    render(<ResidentBankAccountForm kind="payment" intentId="pi_exact" clientSecret="pi_secret"
      amountCents={1234} />);
    expect(await screen.findByText(/debit this bank account once for \$12\.34/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pay from bank" })).toBeDisabled();
    expect(state.confirm).not.toHaveBeenCalled();
  });

  it("does not show a provider-succeeded payment as received when receipt refresh fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Receipt not settled." }), { status: 409 })));
    render(<ResidentBankAccountForm kind="payment" intentId="pi_exact" clientSecret="pi_secret"
      amountCents={1234} initialStatus="paid" />);
    expect(screen.getByText("Confirming receipt…")).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("Receipt not settled.");
    expect(screen.queryByText("Payment received")).not.toBeInTheDocument();
  });
});
