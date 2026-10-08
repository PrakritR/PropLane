/**
 * One list of Stripe dispute statuses that need nobody any more. The admin
 * Dashboard count and the Health list must agree about what "open" means, so
 * both read this instead of repeating the literal.
 */
export const CLOSED_DISPUTE_STATUSES = ["won", "lost", "warning_closed", "charge_refunded"] as const;

/** The same list as a PostgREST `not in` argument: `(won,lost,…)`. */
export const CLOSED_DISPUTE_STATUSES_FILTER = `(${CLOSED_DISPUTE_STATUSES.join(",")})`;
