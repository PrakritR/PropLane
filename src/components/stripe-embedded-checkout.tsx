"use client";

import { EmbeddedCheckout, EmbeddedCheckoutProvider } from "@stripe/react-stripe-js";
import { getStripe } from "@/lib/stripe-browser";

export function StripeEmbeddedCheckout({
  clientSecret,
  className,
  onComplete,
}: {
  clientSecret: string;
  className?: string;
  onComplete?: () => void;
}) {
  return (
    <div className={className ?? "min-h-[360px] overflow-hidden rounded-2xl border border-border bg-card"}>
      <EmbeddedCheckoutProvider key={clientSecret} stripe={getStripe()} options={{ clientSecret, ...(onComplete ? { onComplete } : {}) }}>
        <EmbeddedCheckout />
      </EmbeddedCheckoutProvider>
    </div>
  );
}
