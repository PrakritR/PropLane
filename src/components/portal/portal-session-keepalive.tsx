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

function sessionNeedsRefresh(expiresAt: number | undefined): boolean {
  if (!expiresAt || !Number.isFinite(expiresAt)) return true;
  return expiresAt <= Math.floor(Date.now() / 1000) + REFRESH_EARLY_SECONDS;
}

async function refreshPortalSession(): Promise<void> {
  if (refreshPortalSessionInFlight) return refreshPortalSessionInFlight;
  const refresh = (async () => {
    try {
      const supabase = createSupabaseBrowserClient();
      const { session } = await safeBrowserGetSession(supabase);
      if (!session || !sessionNeedsRefresh(session.expires_at)) return;
      const { error } = await supabase.auth.refreshSession();
      if (error && isStaleRefreshTokenError(error)) {
        await clearStaleBrowserAuth(supabase);
        return;
      }
      try {
        window.localStorage.setItem(SIGNED_IN_FLAG_KEY, "1");
      } catch {
        /* ignore */
      }
    } catch {
      /* ignore — keepalive is best-effort */
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
