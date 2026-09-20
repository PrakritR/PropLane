import type Stripe from "stripe";

/**
 * Stripe Connect embedded components this app mounts inside PropLane's own
 * modal chrome. Replaces Account Links (a redirect to connect.stripe.com) and
 * Express Dashboard login links — identity and bank linking never leave the
 * app. See PLAN-0920-0853.
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
 * Some platform configurations reject `disable_stripe_user_authentication`;
 * retry once without it rather than failing the whole setup step.
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

  const withAuthToggle: Stripe.AccountSessionCreateParams.Components = {
    [component]: {
      enabled: true,
      features:
        component === "account_onboarding"
          ? { external_account_collection: true, disable_stripe_user_authentication: true }
          : component === "account_management"
            ? { external_account_collection: true }
            : undefined,
    },
  } as Stripe.AccountSessionCreateParams.Components;

  try {
    const session = await stripe.accountSessions.create({ account: accountId, components: withAuthToggle });
    return { clientSecret: session.client_secret, publishableKey };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("disable_stripe_user_authentication")) throw error;
    const withoutAuthToggle: Stripe.AccountSessionCreateParams.Components = {
      [component]: { enabled: true },
    } as Stripe.AccountSessionCreateParams.Components;
    const session = await stripe.accountSessions.create({ account: accountId, components: withoutAuthToggle });
    return { clientSecret: session.client_secret, publishableKey };
  }
}
