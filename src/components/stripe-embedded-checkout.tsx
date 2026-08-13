"use client";

import { EmbeddedCheckout, EmbeddedCheckoutProvider } from "@stripe/react-stripe-js";
import { loadStripe } from "@stripe/stripe-js";

const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY!);

export function StripeEmbeddedCheckout({
  clientSecret,
  className,
}: {
  clientSecret: string;
  className?: string;
}) {
  return (
    <div className={className ?? "min-h-[360px] overflow-hidden rounded-2xl border border-border bg-card"}>
      <EmbeddedCheckoutProvider key={clientSecret} stripe={stripePromise} options={{ clientSecret }}>
        <EmbeddedCheckout />
      </EmbeddedCheckoutProvider>
    </div>
  );
}
