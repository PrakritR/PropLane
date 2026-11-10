/** Keep signup test addresses bounded to synthetic-only domains. */
export function syntheticSignupDomain(): string {
  const domain = process.env.E2E_SIGNUP_EMAIL_DOMAIN ?? "test.proplane.local";
  if (domain !== "test.proplane.local" && domain !== "example.invalid") throw new Error("E2E_SIGNUP_EMAIL_DOMAIN must be test.proplane.local or example.invalid.");
  return domain;
}
