/**
 * A bounded wait for an auth call, so no path can leave a button spinning.
 *
 * After creating an account the signup forms signed the user in and awaited it
 * with no timeout. When that call fails at the NETWORK level — a flaky
 * connection, captive-portal wifi, a blocking extension — the promise never
 * settles, the `finally` that clears the busy flag never runs, and the button
 * stays `aria-busy` forever with no message. The account exists; the person is
 * told nothing, concludes it failed, and retries into "already registered"
 * (PRP-187).
 *
 * Extracted from `portal-auth-form.tsx`, which already had it, so the signup
 * forms stop being the ones without it.
 */
export class AuthTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthTimeoutError";
  }
}

/** 6s — long enough for a slow-but-working network, short enough not to read as a hang. */
export const AUTH_CALL_TIMEOUT_MS = 6000;

export function withAuthTimeout<T>(
  promise: PromiseLike<T>,
  timeoutMs: number = AUTH_CALL_TIMEOUT_MS,
  message = "That took too long. Please try again.",
): Promise<T> {
  let timeoutId = 0;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(() => reject(new AuthTimeoutError(message)), timeoutMs);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => window.clearTimeout(timeoutId));
}
