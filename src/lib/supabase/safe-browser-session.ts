import type { Session, SupabaseClient } from "@supabase/supabase-js";

const SIGNED_IN_FLAG_KEY = "axis:signed_in";

/** True when Supabase cannot refresh because the refresh token cookie is missing or revoked. */
export function isStaleRefreshTokenError(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === "string") {
    const value = error.toLowerCase();
    return value.includes("invalid refresh token") || value.includes("refresh token not found");
  }
  if (typeof error !== "object") return false;

  const record = error as { message?: string; code?: string; status?: number };
  const message = String(record.message ?? "").toLowerCase();
  const code = String(record.code ?? "").toLowerCase();
  if (message.includes("invalid refresh token") || message.includes("refresh token not found")) {
    return true;
  }
  if (code.includes("refresh_token") || code === "session_not_found") return true;
  return record.status === 401 && message.includes("refresh");
}

export async function clearStaleBrowserAuth(supabase: SupabaseClient): Promise<void> {
  await supabase.auth.signOut({ scope: "local" }).catch(() => undefined);
  try {
    window.localStorage.removeItem(SIGNED_IN_FLAG_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Read the browser session without surfacing AuthApiError when refresh cookies are corrupt.
 * Clears local auth storage so public pages (tour/message links) keep working as a guest.
 */
export async function safeBrowserGetSession(supabase: SupabaseClient): Promise<{ session: Session | null }> {
  try {
    const { data, error } = await supabase.auth.getSession();
    if (error && isStaleRefreshTokenError(error)) {
      await clearStaleBrowserAuth(supabase);
      return { session: null };
    }
    return { session: data.session ?? null };
  } catch (error) {
    if (isStaleRefreshTokenError(error)) {
      await clearStaleBrowserAuth(supabase);
      return { session: null };
    }
    return { session: null };
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
