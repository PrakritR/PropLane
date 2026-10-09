import type { Session, SupabaseClient } from "@supabase/supabase-js";

const SIGNED_IN_FLAG_KEY = "axis:signed_in";

/**
 * True ONLY when Supabase says the refresh token is definitively gone: the
 * cookie is missing or revoked. This is the sole condition under which an app
 * may clear the visitor's auth cookies.
 *
 * Deliberately NOT matched (each used to log people out of the mobile app):
 *  - `refresh_token_already_used` / "Already Used": a rotation race (middleware,
 *    auto-refresh and the keepalive all rotate the same token). The next
 *    request carries the new cookie.
 *  - `session_not_found` and a bare 401 that merely mentions "refresh".
 *  - network failures, 429 and 5xx: the session may be perfectly fine.
 */
export function isStaleRefreshTokenError(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === "string") {
    return isDefinitelyStaleMessage(error.toLowerCase());
  }
  if (typeof error !== "object") return false;

  const record = error as { message?: string; code?: string; status?: number };
  const code = String(record.code ?? "").toLowerCase();
  if (code === "refresh_token_not_found") return true;
  if (code === "refresh_token_already_used") return false;
  return isDefinitelyStaleMessage(String(record.message ?? "").toLowerCase());
}

function isDefinitelyStaleMessage(message: string): boolean {
  if (message.includes("already used")) return false;
  return message.includes("invalid refresh token") || message.includes("refresh token not found");
}

export async function clearStaleBrowserAuth(supabase: SupabaseClient): Promise<void> {
  await supabase.auth.signOut({ scope: "local" }).catch(() => undefined);
  try {
    window.localStorage.removeItem(SIGNED_IN_FLAG_KEY);
  } catch {
    /* ignore */
  }
}

export type SafeBrowserSession = {
  session: Session | null;
  /**
   * True when the read failed for a reason that says nothing about whether the
   * visitor is signed in (offline, 429, 5xx, a rotation race). `session: null`
   * is NOT an answer in that case: callers retry and must not treat it as a
   * logout. Cookies are left untouched.
   */
  transientError?: boolean;
};

/**
 * Read the browser session without surfacing AuthApiError when refresh cookies are corrupt.
 * Clears local auth storage ONLY for a definitively stale refresh token so public
 * pages (tour/message links) keep working as a guest. Any other failure is reported
 * as `transientError` and leaves the cookies alone.
 */
export async function safeBrowserGetSession(supabase: SupabaseClient): Promise<SafeBrowserSession> {
  try {
    const { data, error } = await supabase.auth.getSession();
    if (error) {
      if (isStaleRefreshTokenError(error)) {
        await clearStaleBrowserAuth(supabase);
        return { session: null };
      }
      if (!data?.session) return { session: null, transientError: true };
    }
    return { session: data.session ?? null };
  } catch (error) {
    if (isStaleRefreshTokenError(error)) {
      await clearStaleBrowserAuth(supabase);
      return { session: null };
    }
    return { session: null, transientError: true };
  }
}

export const SESSION_RETRY_DELAYS_MS: readonly number[] = [1000, 2000, 4000, 8000];

/**
 * {@link safeBrowserGetSession} with backoff on transient failures. `settled`
 * is false when every attempt failed transiently: the caller must keep waiting
 * (and retry later), never publish "signed out".
 */
export async function getBrowserSessionWithRetry(
  supabase: SupabaseClient,
  options: {
    delaysMs?: readonly number[];
    sleep?: (ms: number) => Promise<void>;
    isCancelled?: () => boolean;
  } = {},
): Promise<{ session: Session | null; settled: boolean }> {
  const delays = options.delaysMs ?? SESSION_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt += 1) {
    const result = await safeBrowserGetSession(supabase);
    if (!result.transientError) return { session: result.session, settled: true };
    if (attempt >= delays.length || options.isCancelled?.()) return { session: null, settled: false };
    await sleep(delays[attempt]);
  }
}

let recoveryListenerRegistered = false;

/**
 * `autoRefreshToken: true` makes auth-js run its own background token-refresh
 * timer, independent of any `getSession()`/`getUser()` call app code awaits.
 * When that background refresh's own `fetch` fails — a network blip, or the
 * tab navigating/backgrounding mid-request — there is no app-level promise to
 * attach a `.catch` to, so it surfaces as an uncaught
 * `TypeError: Failed to fetch` from inside auth-js's own internals (Night QA:
 * resident Tour page, both viewports, `_handleRequest`/`_request`). It is not
 * correctness-affecting: the timer retries on its own next tick, and any
 * explicit `getSession()` call already recovers via {@link safeBrowserGetSession}.
 * Mark it handled instead of letting it reach the console as an uncaught error.
 */
export function isBenignAuthJsBackgroundFetchFailure(reason: unknown): boolean {
  if (!(reason instanceof TypeError) || reason.message !== "Failed to fetch") return false;
  const stack = reason.stack ?? "";
  return /auth-js|gotrue|_handleRequest|_recoverAndRefresh|_autoRefreshTokenTick/i.test(stack);
}

let unhandledRejectionListenerRegistered = false;

function registerAuthJsBackgroundRefreshRecovery(): void {
  if (typeof window === "undefined" || unhandledRejectionListenerRegistered) return;
  unhandledRejectionListenerRegistered = true;
  window.addEventListener("unhandledrejection", (event) => {
    if (isBenignAuthJsBackgroundFetchFailure(event.reason)) event.preventDefault();
  });
}

/** One global listener so auto-refresh failures never leave a dead session behind. */
export function registerBrowserAuthRecovery(supabase: SupabaseClient): void {
  if (typeof window === "undefined" || recoveryListenerRegistered) return;
  recoveryListenerRegistered = true;

  registerAuthJsBackgroundRefreshRecovery();

  supabase.auth.onAuthStateChange((event, session) => {
    if (event === "SIGNED_OUT" && !session) {
      try {
        window.localStorage.removeItem(SIGNED_IN_FLAG_KEY);
      } catch {
        /* ignore */
      }
    }
  });

  // Clear corrupt refresh cookies before other callers race on raw getSession().
  void safeBrowserGetSession(supabase);
}
