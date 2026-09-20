import { isDemoModeActive } from "@/lib/demo/demo-session";

export type StripeConnectEmbeddedComponent = "account_onboarding" | "account_management";

export type StripeConnectAccountSession = {
  clientSecret: string;
  publishableKey: string;
};

/**
 * Fetches an Account Session client secret for a Stripe Connect embedded
 * component (identity + bank onboarding, or bank management).
 *
 * Onboarding and account management run INSIDE PropLane's own modal now
 * (`StripeConnectEmbedded`) — this never opens a new tab, never mints an
 * Account Link or an Express login link the way the old popup flow did
 * (PLAN-0920-0853). Connect.js calls this again on its own whenever the
 * mounted component needs a fresh secret, so it is a plain fetch rather than
 * something that owns a popup or navigation.
 */
export async function fetchStripeConnectAccountSession(opts: {
  /** `/api/stripe/connect` for a manager, `/api/vendor/stripe-connect` for a vendor. */
  connectBase: string;
  component: StripeConnectEmbeddedComponent;
}): Promise<StripeConnectAccountSession> {
  if (isDemoModeActive()) {
    throw new Error("Demo mode — payouts are already linked to a sandbox account.");
  }
  const res = await fetch(`${opts.connectBase}/account-session`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ component: opts.component }),
  });
  const body = (await res.json().catch(() => ({}))) as Partial<StripeConnectAccountSession> & { error?: string };
  if (!res.ok || !body.clientSecret || !body.publishableKey) {
    throw new Error(body.error ?? "Could not start Stripe.");
  }
  return { clientSecret: body.clientSecret, publishableKey: body.publishableKey };
}
