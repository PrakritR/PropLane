/**
 * @vitest-environment jsdom
 *
 * C203: a hung embedded checkout ("Processing…" that never redirects back)
 * gets a host-side timeout with a message and a same-checkout reload — never
 * a new client secret, so this can never mint a second charge.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const stripeCheckoutSpy = vi.fn();

vi.mock("@/components/stripe-embedded-checkout", () => ({
  StripeEmbeddedCheckout: (props: { clientSecret: string }) => {
    stripeCheckoutSpy(props);
    return <div data-testid="stripe-embedded-checkout" />;
  },
}));
vi.mock("@/lib/dom-visibility", () => ({ isElementOnScreen: () => true }));
vi.mock("@/lib/rental-application/fee-checkout-resume", () => ({
  rememberApplicationFeeCheckoutResume: vi.fn(),
}));
vi.mock("@/lib/rental-application/drafts", () => ({
  loadRentalWizardDraftAxisId: () => undefined,
}));

import {
  ApplicationFeeInlinePayment,
  setApplicationFeeStuckTimeoutMsForTests,
} from "@/components/marketing/application-fee-inline-payment";

function renderComponent() {
  return render(
    <ApplicationFeeInlinePayment
      propertyId="prop-1"
      residentEmail="dana@example.com"
      managerUserId="mgr-1"
      returnPath="/apply/prop-1"
    />,
  );
}

beforeEach(() => {
  stripeCheckoutSpy.mockReset();
  setApplicationFeeStuckTimeoutMsForTests(20);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        clientSecret: "cs_test_123",
        applicationFeeCents: 5000,
        serviceFeeCents: 0,
        totalCents: 5000,
      }),
    })),
  );
});

afterEach(() => {
  cleanup();
  setApplicationFeeStuckTimeoutMsForTests(null);
  vi.unstubAllGlobals();
});

describe("ApplicationFeeInlinePayment — stuck checkout retry (C203)", () => {
  it("mounts the embedded checkout with the server's client secret", async () => {
    renderComponent();
    await screen.findByTestId("stripe-embedded-checkout");
    expect(stripeCheckoutSpy).toHaveBeenCalledWith(expect.objectContaining({ clientSecret: "cs_test_123" }));
  });

  it("shows no stuck banner immediately after mounting", async () => {
    renderComponent();
    await screen.findByTestId("stripe-embedded-checkout");
    expect(document.querySelector('[data-attr="application-fee-inline-stuck"]')).toBeNull();
  });

  it("shows a reload option once the checkout has sat unresolved past the timeout", async () => {
    renderComponent();
    await screen.findByTestId("stripe-embedded-checkout");
    await waitFor(() =>
      expect(document.querySelector('[data-attr="application-fee-inline-stuck"]')).toBeTruthy(),
    );
    expect(document.querySelector('[data-attr="application-fee-inline-reload"]')).toBeTruthy();
  });

  it("reload remounts the SAME checkout without fetching a new client secret", async () => {
    renderComponent();
    await screen.findByTestId("stripe-embedded-checkout");
    await waitFor(() =>
      expect(document.querySelector('[data-attr="application-fee-inline-stuck"]')).toBeTruthy(),
    );
    expect(fetch).toHaveBeenCalledTimes(1);

    const reloadBtn = document.querySelector('[data-attr="application-fee-inline-reload"]') as HTMLElement;
    fireEvent.click(reloadBtn);

    // Same client secret, never a second server call — never a second charge.
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(stripeCheckoutSpy).toHaveBeenLastCalledWith(expect.objectContaining({ clientSecret: "cs_test_123" }));
    // The stuck banner clears and the timer restarts.
    expect(document.querySelector('[data-attr="application-fee-inline-stuck"]')).toBeNull();
  });
});
