import type Stripe from "stripe";

/**
 * Stripe Connect embedded components this app mounts inside PropLane's own
 * modal chrome. An unsupported account configuration fails before mounting
 * a component that could open a Stripe authentication popup.
 */
export type EmbeddedComponent = "account_onboarding" | "account_management" | "notification_banner";

const EMBEDDED_COMPONENTS: readonly EmbeddedComponent[] = [
  "account_onboarding",
  "account_management",
  "notification_banner",
];

export function isEmbeddedComponent(value: unknown): value is EmbeddedComponent {
  return typeof value === "string" && (EMBEDDED_COMPONENTS as readonly string[]).includes(value);
}

export type AccountSessionResult = { clientSecret: string; publishableKey: string };

/**
 * Creates a Stripe Account Session scoped to exactly one embedded component.
 * `account_onboarding` collects the external bank account in the same flow
 * (`external_account_collection: true`) so identity and bank linking are one
 * step, never a raw form PropLane draws or stores fields for.
 *
 * Legacy Stripe-collected accounts cannot disable Stripe user authentication.
 * Never retry without the toggle: that may launch a Stripe-owned popup.
 */
export async function createAccountSession(
  stripe: Stripe,
  accountId: string,
  component: EmbeddedComponent,
): Promise<AccountSessionResult> {
  const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
  if (!publishableKey) {
    throw new Error("Missing NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY");
  }

  const account = await stripe.accounts.retrieve(accountId);
  if (account.controller?.requirement_collection !== "application" ||
      account.controller?.stripe_dashboard?.type !== "none") {
    throw new Error("This Stripe payout account requires a Stripe sign-in outside PropLane. Contact support to review payout setup; your account will not be changed automatically.");
  }

  const components: Stripe.AccountSessionCreateParams.Components = {
    [component]: {
      enabled: true,
      features: component === "notification_banner"
        ? { disable_stripe_user_authentication: true }
        : { external_account_collection: true, disable_stripe_user_authentication: true },
    },
  } as Stripe.AccountSessionCreateParams.Components;

  const session = await stripe.accountSessions.create({ account: accountId, components });
  return { clientSecret: session.client_secret, publishableKey };
}
