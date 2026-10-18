"use client";

import { useCallback, useRef, useState } from "react";
import { fetchJsonWithTimeout } from "@/lib/fetch-json-with-timeout";

/**
 * Lifted from the old `manager-comms-billing-panel.tsx` so both the Extra
 * usage panel and any other future buy-credit surface share one idempotent
 * checkout flow. `checkout(creditCents, workspaceId)` opens (or resumes) an
 * embedded Stripe Checkout session that buys that amount for that workspace's
 * wallet; the operation id is stable across re-renders as long as the amount
 * and workspace haven't changed, so a re-render never opens a second Stripe
 * session for the same in-flight purchase.
 */
export type CreditCheckoutState = {
  clientSecret: string | null;
  loading: boolean;
  error: string | null;
  purchaseId: string | null;
};

const ENDPOINT = "/api/manager/comms-billing/checkout";

/** This flow's own timeout copy — only the checkout call site says "checkout". */
export const CHECKOUT_TIMEOUT_MESSAGE = "Checkout is taking too long. Check your connection and try again.";

export function useCreditCheckout() {
  const lastRequest = useRef<{ creditCents: number; workspaceId: string } | null>(null);
  const operation = useRef<{
    id: string;
    amount: number;
    workspaceId: string;
  } | null>(null);
  const [state, setState] = useState<CreditCheckoutState>({
    clientSecret: null,
    loading: false,
    error: null,
    purchaseId: null,
  });

  const checkout = useCallback(async (creditCents: number, workspaceId: string): Promise<string | null> => {
    setState((s) => ({ ...s, loading: true, error: null }));
    lastRequest.current = { creditCents, workspaceId };
    if (
      !operation.current ||
      operation.current.amount !== creditCents ||
      operation.current.workspaceId !== workspaceId
    ) {
      operation.current = { id: crypto.randomUUID(), amount: creditCents, workspaceId };
    }
    try {
      const { ok, body } = await fetchJsonWithTimeout<{ clientSecret?: string; purchaseId?: string; error?: string }>(
        ENDPOINT,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ purchaseId: operation.current.id, creditCents, workspaceId }),
        },
        { timeoutMessage: CHECKOUT_TIMEOUT_MESSAGE },
      );
      if (!ok || !body.clientSecret) throw new Error(body.error || "Checkout could not be opened.");
      setState({ clientSecret: body.clientSecret, loading: false, error: null, purchaseId: body.purchaseId ?? null });
      return body.purchaseId ?? null;
    } catch (e) {
      const message = e instanceof Error ? e.message : "Checkout could not be opened.";
      setState((s) => ({ ...s, loading: false, error: message }));
      return null;
    }
  }, []);

  /** Re-run the last request under the same operation id, so a retry never opens a second session. */
  const retry = useCallback(async (): Promise<string | null> => {
    const last = lastRequest.current;
    return last ? checkout(last.creditCents, last.workspaceId) : null;
  }, [checkout]);

  const reset = useCallback(() => {
    lastRequest.current = null;
    operation.current = null;
    setState({ clientSecret: null, loading: false, error: null, purchaseId: null });
  }, []);

  return { ...state, checkout, retry, reset };
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
