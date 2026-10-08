"use client";

import { useEffect } from "react";
import { detectNativePlatformSync } from "@/lib/native/detect-native";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import {
  clearStaleBrowserAuth,
  isStaleRefreshTokenError,
  safeBrowserGetSession,
} from "@/lib/supabase/safe-browser-session";

const SIGNED_IN_FLAG_KEY = "axis:signed_in";
// Refresh before expiry, but avoid consuming rotating refresh tokens while the
// current browser session is still safely usable.
const REFRESH_EARLY_SECONDS = 5 * 60;

let refreshPortalSessionInFlight: Promise<void> | null = null;

/** Backoff for a refresh that failed for a reason that says nothing about the login (offline on resume, 429, 5xx). */
export const KEEPALIVE_RETRY_DELAYS_MS: readonly number[] = [1500, 4000, 10000];

function sessionNeedsRefresh(expiresAt: number | undefined): boolean {
  if (!expiresAt || !Number.isFinite(expiresAt)) return true;
  return expiresAt <= Math.floor(Date.now() / 1000) + REFRESH_EARLY_SECONDS;
}

/** One refresh attempt. Resolves true when it failed transiently and is worth retrying. */
async function refreshPortalSessionOnce(): Promise<boolean> {
  try {
    const supabase = createSupabaseBrowserClient();
    const { session, transientError } = await safeBrowserGetSession(supabase);
    if (transientError) return true;
    if (!session || !sessionNeedsRefresh(session.expires_at)) return false;
    const { error } = await supabase.auth.refreshSession();
    if (error) {
      // Only a definitively dead refresh token ends the login. Anything else
      // (network, 429, a rotation race) keeps the cookies and tries again.
      if (isStaleRefreshTokenError(error)) {
        await clearStaleBrowserAuth(supabase);
        return false;
      }
      return true;
    }
    try {
      window.localStorage.setItem(SIGNED_IN_FLAG_KEY, "1");
    } catch {
      /* ignore */
    }
    return false;
  } catch {
    return true; // keepalive is best-effort
  }
}

export async function refreshPortalSession(
  retryDelaysMs: readonly number[] = KEEPALIVE_RETRY_DELAYS_MS,
): Promise<void> {
  if (refreshPortalSessionInFlight) return refreshPortalSessionInFlight;
  const refresh = (async () => {
    for (let attempt = 0; ; attempt += 1) {
      const retry = await refreshPortalSessionOnce();
      if (!retry || attempt >= retryDelaysMs.length) return;
      await new Promise<void>((resolve) => setTimeout(resolve, retryDelaysMs[attempt]));
    }
  })();
  refreshPortalSessionInFlight = refresh;
  try {
    await refresh;
  } finally {
    if (refreshPortalSessionInFlight === refresh) refreshPortalSessionInFlight = null;
  }
}

/**
 * Renews Supabase auth on resume so mobile Safari and the Capacitor shell do not
 * drop back to sign-in after backgrounding.
 */
export function PortalSessionKeepalive() {
  useEffect(() => {
    void refreshPortalSession();

    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshPortalSession();
    };
    document.addEventListener("visibilitychange", onVisible);

    let removeResume: (() => void) | undefined;
    if (detectNativePlatformSync()) {
      void import("@capacitor/app")
        .then(({ App }) => App.addListener("resume", () => void refreshPortalSession()))
        .then((handle) => {
          removeResume = () => void handle.remove();
        })
        .catch(() => undefined);
    }

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      removeResume?.();
    };
  }, []);

  return null;
}
