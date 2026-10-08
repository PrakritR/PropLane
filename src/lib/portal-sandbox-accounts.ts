/** The address endings that mark a sandbox account. One list: the predicate and every admin count read it. */
export const PORTAL_SANDBOX_EMAIL_SUFFIXES = ["@axis.local", "@test.proplane.local"] as const;

/** Emails used for the public `/demo` sandbox and production demo seeds — hidden from real portal admin views. */
export function isPortalSandboxEmail(email: string | null | undefined): boolean {
  const normalized = email?.trim().toLowerCase() ?? "";
  if (!normalized.includes("@")) return false;
  return PORTAL_SANDBOX_EMAIL_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

/** Skip Resend / external SMTP for sandbox seed accounts (same rule as isPortalSandboxEmail). */
export function shouldSkipOutboundEmail(email: string | null | undefined): boolean {
  return isPortalSandboxEmail(email);
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
