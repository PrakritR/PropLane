// @vitest-environment jsdom
/**
 * The money icons on a manager's Subscription card: Change price / Refund / Cancel are disabled with the tooltip
 * "No card subscription" when there is no Stripe subscription, End promo exists only when the account has a promo code,
 * and the Refund popup posts the picked invoice, the amount in cents and a per-dialog nonce.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { dollarsToCents, useBillingMoneyActions } from "@/components/portal/admin-billing-money-actions";
import type { AdminAccountBilling } from "@/lib/admin/admin-account-billing.server";

const billing = (over: { subscriptionLinked?: boolean; promoCode?: string | null; payments?: AdminAccountBilling["payments"] } = {}): AdminAccountBilling =>
  ({
    plan: { promoCode: over.promoCode ?? null, monthlyCents: 4000 },
    payments: over.payments ?? [],
    stripe: { subscriptionLinked: over.subscriptionLinked ?? true },
  }) as unknown as AdminAccountBilling;

function Harness({ b, onChanged }: { b: AdminAccountBilling; onChanged: () => void }) {
  const { icons, dialogs } = useBillingMoneyActions({ userId: "u-1", billing: b, onChanged, showToast: vi.fn() });
  return (
    <div>
      {icons}
      {dialogs}
    </div>
  );
}

const payment = (id: string, amountCents: number) => ({
  id,
  at: "2026-10-01T00:00:00.000Z",
  amountCents,
  currency: "usd",
  status: "paid",
  description: "Pro",
  number: `N-${id}`,
  invoiceUrl: null,
  subscriptionInvoice: true,
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("dollarsToCents", () => {
  it("accepts whole cents only, above zero", () => {
    expect(dollarsToCents("40")).toBe(4000);
    expect(dollarsToCents("$12.50")).toBe(1250);
    expect(dollarsToCents("0")).toBeNull();
    expect(dollarsToCents("-5")).toBeNull();
    expect(dollarsToCents("1.234")).toBeNull();
    expect(dollarsToCents("abc")).toBeNull();
    expect(dollarsToCents("")).toBeNull();
  });
});

describe("billing money icons", () => {
  it("without a card subscription Change price and Cancel are disabled with the tooltip, Refund too with no invoice, no End promo", () => {
    render(<Harness b={billing({ subscriptionLinked: false })} onChanged={vi.fn()} />);
    const disabled = screen.getAllByRole("button", { name: "No card subscription" }) as HTMLButtonElement[];
    expect(disabled).toHaveLength(3);
    expect(disabled.every((b) => b.disabled)).toBe(true);
    expect(screen.queryByRole("button", { name: "End promo" })).toBeNull();
  });

  it("with a subscription and a promo code all four are live", () => {
    render(<Harness b={billing({ promoCode: "FREE100", payments: [payment("in_1", 4000)] })} onChanged={vi.fn()} />);
    for (const name of ["Change price", "Refund", "Cancel subscription", "End promo"]) {
      expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(false);
    }
  });

  it("Refund posts the invoice, the amount in cents, a nonce and the reason", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
    vi.stubGlobal("fetch", fetchMock);
    const onChanged = vi.fn();
    render(<Harness b={billing({ payments: [payment("in_1", 4000)] })} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "Refund" }));
    const amount = document.querySelector('[data-attr="admin-billing-refund-amount"]') as HTMLInputElement;
    expect(amount.value).toBe("40.00");
    fireEvent.change(amount, { target: { value: "15.50" } });
    fireEvent.change(document.querySelector('[data-attr="admin-billing-refund-dialog-reason"]') as HTMLInputElement, {
      target: { value: "Billing error" },
    });
    fireEvent.click(document.querySelector('[data-attr="admin-billing-refund-dialog-submit"]') as HTMLButtonElement);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/admin/accounts/u-1/billing/refund");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ invoiceId: "in_1", amountCents: 1550, reason: "Billing error" });
    expect(String(body.nonce).length).toBeGreaterThanOrEqual(8);
  });

  it("will not submit a refund above the invoice amount", () => {
    render(<Harness b={billing({ payments: [payment("in_1", 4000)] })} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Refund" }));
    fireEvent.change(document.querySelector('[data-attr="admin-billing-refund-amount"]') as HTMLInputElement, { target: { value: "40.01" } });
    fireEvent.change(document.querySelector('[data-attr="admin-billing-refund-dialog-reason"]') as HTMLInputElement, { target: { value: "x" } });
    expect((document.querySelector('[data-attr="admin-billing-refund-dialog-submit"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it("End promo posts { endsAt: 'now', reason } to the end-promo route", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
    vi.stubGlobal("fetch", fetchMock);
    render(<Harness b={billing({ promoCode: "FREE100" })} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "End promo" }));
    fireEvent.change(document.querySelector('[data-attr="admin-billing-end-promo-dialog-reason"]') as HTMLInputElement, { target: { value: "Promo over" } });
    fireEvent.click(document.querySelector('[data-attr="admin-billing-end-promo-dialog-submit"]') as HTMLButtonElement);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/admin/accounts/u-1/billing/end-promo");
    expect(JSON.parse(String(init.body))).toEqual({ endsAt: "now", reason: "Promo over" });
  });
});
