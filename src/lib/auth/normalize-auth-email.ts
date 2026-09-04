/**
 * The address to hand the auth provider.
 *
 * Email local-parts are case-SENSITIVE to the provider, so `Manager@…` and
 * `manager@…` are two different accounts. Signup already stored lowercase, so
 * only sign-in could produce the mismatch — and the failure it produced was
 * "Invalid login credentials", i.e. the wrong-password error for an account the
 * person owns and typed correctly by any human standard. iOS and macOS
 * autocapitalise the first letter by default, so this is the ordinary case on a
 * phone, not an edge one.
 *
 * It compounds badly: the user retries the password, then resets it, and the
 * reset succeeds — because reset DOES normalize — leaving them certain the
 * password was the problem.
 *
 * One function so every path that names an account to the provider agrees:
 * password sign-in, signup, re-auth, resend and reset.
 */
export function normalizeAuthEmail(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}
