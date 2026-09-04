/**
 * What a payment surface is allowed to SAY when starting a payment fails.
 *
 * Two surfaces rendered the server's `error` string verbatim. At the moment of
 * paying, a prospective tenant was shown
 *
 *   "Stripe is not configured on the server (missing STRIPE_SECRET_KEY)."
 *
 * with a "Try again" button that could not help, because the key would still be
 * missing (PRP-207). On the resident side the server already answered 422
 * `MANAGER_NO_CONNECT_ACCOUNT` — the code exists precisely so the client can say
 * something useful — and nothing read it, so the resident got a raw string for a
 * bill the product had told them they could pay (PRP-253).
 *
 * One rule, shared: a payment surface never renders a raw server error, and
 * always offers a next step.
 */

/** An env-var-shaped token: SCREAMING_SNAKE with at least one underscore. */
const INTERNAL_IDENTIFIER = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/;

export type PaymentFailureCopy = {
  message: string;
  /** Whether retrying could plausibly succeed. A missing server key cannot. */
  canRetry: boolean;
  /** True when the blocker is the manager's setup, not the payer's. */
  blockedByManagerSetup: boolean;
};

const BY_CODE: Record<string, PaymentFailureCopy> = {
  STRIPE_NOT_CONFIGURED: {
    message: "Card payments are temporarily unavailable. Nothing has been charged.",
    canRetry: false,
    blockedByManagerSetup: false,
  },
  MANAGER_NO_CONNECT_ACCOUNT: {
    message:
      "Your property manager hasn't finished setting up card payments yet, so this can't be paid by card right now. Nothing has been charged.",
    canRetry: false,
    blockedByManagerSetup: true,
  },
  MANAGER_CONNECT_TRANSFERS_NOT_READY: {
    message:
      "Your property manager's payout account is still being verified, so card payments aren't available yet. Nothing has been charged.",
    canRetry: false,
    blockedByManagerSetup: true,
  },
};

const GENERIC: PaymentFailureCopy = {
  message: "We couldn't start the payment. Nothing has been charged.",
  canRetry: true,
  blockedByManagerSetup: false,
};

/**
 * `serverMessage` is passed through ONLY when it is a 4xx that reads like it was
 * written for the payer. A 5xx is an ops fact, and anything carrying an
 * env-var-shaped token is internal by construction — both become the generic
 * message, with the detail left in the server log where it belongs.
 */
export function paymentFailureCopy(input: {
  code?: string | null;
  status?: number | null;
  serverMessage?: string | null;
}): PaymentFailureCopy {
  const known = input.code ? BY_CODE[input.code.trim()] : undefined;
  if (known) return known;

  const status = input.status ?? 0;
  const message = (input.serverMessage ?? "").trim();
  if (!message || status >= 500 || INTERNAL_IDENTIFIER.test(message)) return GENERIC;
  // A long string is a stack trace or a dump, not a sentence for a payer.
  if (message.length > 200) return GENERIC;
  return { ...GENERIC, message };
}
