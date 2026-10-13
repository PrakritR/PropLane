/** The address endings that mark a sandbox account. One list: the predicate and every admin count read it. */
export const PORTAL_SANDBOX_EMAIL_SUFFIXES = ["@axis.local", "@test.proplane.local"] as const;

/** Emails used for the public `/demo` sandbox and production demo seeds — hidden from real portal admin views. */
export function isPortalSandboxEmail(email: string | null | undefined): boolean {
  const normalized = email?.trim().toLowerCase() ?? "";
  if (!normalized.includes("@")) return false;
  return PORTAL_SANDBOX_EMAIL_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

/**
 * Addresses PropLane mints itself for a channel that carries no email (a Facebook
 * Messenger lead is filed as `facebook-<psid>@facebook.proplane.local`). They are a
 * thread key, never a mailbox: handing one to Resend is a hard bounce charged to the
 * workspace's own sending domain, so nothing outbound may ever be sent to them.
 */
export const PORTAL_UNDELIVERABLE_EMAIL_SUFFIXES = ["@facebook.proplane.local"] as const;

/** A PropLane-minted stand-in address with no mailbox behind it. */
export function isUndeliverableEmailAddress(email: string | null | undefined): boolean {
  const normalized = email?.trim().toLowerCase() ?? "";
  if (!normalized.includes("@")) return false;
  return PORTAL_UNDELIVERABLE_EMAIL_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

/** Skip Resend / external SMTP: sandbox seed accounts, and addresses with no mailbox at all. */
export function shouldSkipOutboundEmail(email: string | null | undefined): boolean {
  return isPortalSandboxEmail(email) || isUndeliverableEmailAddress(email);
}

/** Block co-manager / property links that would mix demo sandbox accounts with real portal users. */
export function isCrossSandboxPortalPair(
  emailA: string | null | undefined,
  emailB: string | null | undefined,
): boolean {
  return isPortalSandboxEmail(emailA) !== isPortalSandboxEmail(emailB);
}

export const CROSS_SANDBOX_PORTAL_PAIR_ERROR =
  "Demo sandbox accounts cannot link with real portal accounts.";
