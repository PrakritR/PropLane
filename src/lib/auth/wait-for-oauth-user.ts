import type { SupabaseClient, User } from "@supabase/supabase-js";

import { withAuthTimeout } from "@/lib/auth/with-timeout";

const DEFAULT_MAX_WAIT_MS = 8_000;
const PER_ATTEMPT_TIMEOUT_MS = 2_500;
const RETRY_DELAY_MS = 200;

type WaitForOAuthUserOptions = {
  attempts?: number;
  delayMs?: number;
  maxWaitMs?: number;
  signal?: AbortSignal;
};

function nonNegativeFinite(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, value ?? fallback);
}

function waitForAuthCall<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => finish(() => reject(new DOMException("Aborted", "AbortError")));
    const finish = (settle: () => void) => {
      signal.removeEventListener("abort", onAbort);
      settle();
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function waitForDelay(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = () => {
      globalThis.clearTimeout(timeout);
      finish();
    };
    const timeout = globalThis.setTimeout(finish, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** After native OAuth, cookies may land a tick after navigation — poll before giving up. */
export async function waitForOAuthUser(
  supabase: SupabaseClient,
  options?: WaitForOAuthUserOptions,
): Promise<User | null> {
  const maxWaitMs = nonNegativeFinite(options?.maxWaitMs, DEFAULT_MAX_WAIT_MS);
  const delayMs = nonNegativeFinite(options?.delayMs, RETRY_DELAY_MS);
  const maxAttempts = options?.attempts === undefined
    ? Number.POSITIVE_INFINITY
    : Math.floor(nonNegativeFinite(options.attempts, 0));
  const signal = options?.signal;
  const deadline = Date.now() + maxWaitMs;
  let attempt = 0;

  while (!signal?.aborted && attempt < maxAttempts && Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    attempt += 1;
    try {
      const authCall = withAuthTimeout(
        supabase.auth.getUser(),
        Math.min(PER_ATTEMPT_TIMEOUT_MS, remainingMs),
      );
      const response = await waitForAuthCall(authCall, signal);
      const {
        data: { user },
      } = response;
      if (user) return user;
    } catch {
      if (signal?.aborted) return null;
      /* Retry until the attempts or wall-clock budget expires. */
    }
    const remainingDelayMs = deadline - Date.now();
    if (attempt >= maxAttempts || remainingDelayMs <= 0) break;
    await waitForDelay(Math.min(delayMs, remainingDelayMs), signal);
  }

  return null;
}
