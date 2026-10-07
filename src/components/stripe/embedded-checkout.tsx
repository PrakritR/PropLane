"use client";

import { stripeLiveJsBlockedMessage, stripePublishableKey } from "@/lib/stripe/stripe-js-client";
import { getStripe } from "@/lib/stripe-browser";
import { useEffect, useRef, useState } from "react";

type Props = {
  clientSecret: string;
  onError: (message: string) => void;
};

type EmbeddedApi = { mount: (el: HTMLElement) => void; destroy: () => void };

/**
 * Mounts Stripe Embedded Checkout in-place (same page). Requires NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY.
 */
export function EmbeddedCheckoutMount({ clientSecret, onError }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const checkoutRef = useRef<EmbeddedApi | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let cancelled = false;

    (async () => {
      const blocked = stripeLiveJsBlockedMessage();
      if (blocked) {
        setErrorMessage(blocked);
        setStatus("error");
        return;
      }

      const pk = stripePublishableKey();
      if (!pk) {
        const message = "Missing NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY.";
        setErrorMessage(message);
        onError(message);
        setStatus("error");
        return;
      }

      try {
        const stripe = await getStripe(pk);
        if (!stripe || cancelled) return;

        const s = stripe as unknown as {
          createEmbeddedCheckoutPage?: (opts: { fetchClientSecret: () => Promise<string> }) => Promise<EmbeddedApi>;
          initEmbeddedCheckout?: (opts: { clientSecret: string }) => Promise<EmbeddedApi>;
        };

        const checkout = (await (s.createEmbeddedCheckoutPage
          ? s.createEmbeddedCheckoutPage({
              fetchClientSecret: async () => clientSecret,
            })
          : s.initEmbeddedCheckout?.({ clientSecret }))) as EmbeddedApi | undefined;
        if (!checkout) {
          throw new Error("Stripe.js missing embedded checkout (createEmbeddedCheckoutPage). Update @stripe/stripe-js.");
        }
        if (cancelled) {
          checkout.destroy();
          return;
        }

        checkout.mount(el);
        checkoutRef.current = checkout;
        setStatus("ready");
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Could not load checkout.";
        setErrorMessage(msg);
        onError(msg);
        setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
      checkoutRef.current?.destroy();
      checkoutRef.current = null;
    };
  }, [clientSecret, onError]);

  return (
    <div className="w-full">
      {status === "loading" ? (
        <p className="text-center text-sm text-slate-500">Loading secure checkout…</p>
      ) : null}
      {errorMessage ? (
        <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-relaxed text-amber-950">
          {errorMessage}
        </p>
      ) : null}
      {status !== "error" ? <div ref={containerRef} className="min-h-[420px] w-full" /> : null}
    </div>
  );
}
