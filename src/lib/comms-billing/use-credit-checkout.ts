"use client";

import { useCallback, useRef, useState } from "react";

/**
 * Lifted from the old `manager-comms-billing-panel.tsx` so both the Extra
 * usage panel and any other future buy-credit surface share one idempotent
 * checkout flow. `checkout(creditCents)` opens (or resumes) an embedded
 * Stripe Checkout session for that amount; the operation id is stable across
 * re-renders as long as the amount hasn't changed, so a re-render never opens
 * a second Stripe session for the same in-flight purchase.
 */
export type CreditCheckoutState = {
  clientSecret: string | null;
  loading: boolean;
  error: string | null;
  purchaseId: string | null;
};

const ENDPOINT = "/api/manager/comms-billing/checkout";

export function useCreditCheckout() {
  const operation = useRef<{ id: string; amount: number } | null>(null);
  const [state, setState] = useState<CreditCheckoutState>({
    clientSecret: null,
    loading: false,
    error: null,
    purchaseId: null,
  });

  const checkout = useCallback(async (creditCents: number): Promise<string | null> => {
    setState((s) => ({ ...s, loading: true, error: null }));
    if (!operation.current || operation.current.amount !== creditCents) {
      operation.current = { id: crypto.randomUUID(), amount: creditCents };
    }
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ purchaseId: operation.current.id, creditCents }),
      });
      const body = (await res.json()) as { clientSecret?: string; purchaseId?: string; error?: string };
      if (!res.ok || !body.clientSecret) throw new Error(body.error || "Checkout could not be opened.");
      setState({ clientSecret: body.clientSecret, loading: false, error: null, purchaseId: body.purchaseId ?? null });
      return body.purchaseId ?? null;
    } catch (e) {
      const message = e instanceof Error ? e.message : "Checkout could not be opened.";
      setState((s) => ({ ...s, loading: false, error: message }));
      return null;
    }
  }, []);

  const reset = useCallback(() => {
    operation.current = null;
    setState({ clientSecret: null, loading: false, error: null, purchaseId: null });
  }, []);

  return { ...state, checkout, reset };
}

/**
 * After the Stripe embedded-checkout return (`?credit=purchased`), the wallet
 * write happens on the webhook, not on this page load — so the return page
 * polls the summary rather than assuming the purchase landed. Stops as soon
 * as purchased credit is HIGHER than it was before checkout started, or after
 * `timeoutMs` (default 20s), whichever comes first; the caller decides what
 * to show if it times out (the honest pre-purchase figure, per the plan's own
 * risk note — never a guessed post-purchase number).
 */
export async function pollUntilCreditPurchaseLands(opts: {
  load: () => Promise<{ purchasedRemainingCents: number } | null>;
  previousPurchasedRemainingCents: number;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<boolean> {
  const timeout = opts.timeoutMs ?? 20_000;
  const interval = opts.intervalMs ?? 1500;
  const deadline = Date.now() + timeout;
  for (;;) {
    const wallet = await opts.load();
    if (wallet && wallet.purchasedRemainingCents > opts.previousPurchasedRemainingCents) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}
