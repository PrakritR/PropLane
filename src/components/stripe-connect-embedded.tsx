"use client";

import { useEffect, useState } from "react";
import { loadConnectAndInitialize, type StripeConnectInstance } from "@stripe/connect-js";
import { ConnectAccountManagement, ConnectAccountOnboarding, ConnectComponentsProvider } from "@stripe/react-connect-js";
import { fetchStripeConnectAccountSession, type StripeConnectEmbeddedComponent } from "@/lib/stripe-connect-onboarding-client";

/**
 * Stripe Connect's embedded identity + bank onboarding and account management,
 * mounted inside PropLane's own modal chrome — never a new tab, never an
 * Account Link / login link (PLAN-0920-0853). PropLane never sees or stores
 * the identity or bank fields Stripe collects; it only asks for a fresh
 * Account Session client secret each time Connect.js needs one.
 */
export function StripeConnectEmbedded({
  connectBase,
  component,
  onExit,
}: {
  /** `/api/stripe/connect` for a manager, `/api/vendor/stripe-connect` for a vendor. */
  connectBase: string;
  component: StripeConnectEmbeddedComponent;
  /** Fires when onboarding reports the user is done (finished or backed out). The caller re-fetches the balance/setup status here. Account management has no such signal — its modal's own close is the caller's cue. */
  onExit?: () => void;
}) {
  const [instance, setInstance] = useState<StripeConnectInstance | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setInstance(null);
    setError(null);
    (async () => {
      try {
        const first = await fetchStripeConnectAccountSession({ connectBase, component });
        if (cancelled) return;
        const stripeConnectInstance = loadConnectAndInitialize({
          publishableKey: first.publishableKey,
          fetchClientSecret: async () => (await fetchStripeConnectAccountSession({ connectBase, component })).clientSecret,
        });
        if (!cancelled) setInstance(stripeConnectInstance);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not start Stripe.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connectBase, component]);

  if (error) {
    return <p className="rounded-xl border px-4 py-3 text-sm portal-banner-danger">{error}</p>;
  }

  if (!instance) {
    return (
      <div role="status" aria-label="Loading" className="h-48 animate-pulse rounded-xl bg-accent/40" />
    );
  }

  return (
    <ConnectComponentsProvider connectInstance={instance}>
      {component === "account_onboarding" ? (
        <ConnectAccountOnboarding onExit={() => onExit?.()} />
      ) : (
        <ConnectAccountManagement />
      )}
    </ConnectComponentsProvider>
  );
}
