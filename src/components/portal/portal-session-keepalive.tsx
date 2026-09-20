"use client";

import { useEffect } from "react";
import type { AuthChangeEvent, Session } from "@supabase/supabase-js";
import { detectNativePlatformSync } from "@/lib/native/detect-native";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { clearStaleBrowserAuth } from "@/lib/supabase/safe-browser-session";
import { createPortalSessionRefreshCoordinator } from "@/lib/supabase/portal-session-refresh";

const SIGNED_IN_FLAG_KEY = "axis:signed_in";

const portalSessionRefresh = createPortalSessionRefreshCoordinator({
  getSession: async () => {
    const supabase = createSupabaseBrowserClient();
    // Keep this read non-destructive. The coordinator owns permanent-error
    // cleanup so it can reject stale reads after an auth lifecycle change.
    const { data, error } = await supabase.auth.getSession();
    return { session: data.session ?? null, error };
  },
  refreshSession: async () => createSupabaseBrowserClient().auth.refreshSession(),
  clearStaleAuth: async () => clearStaleBrowserAuth(createSupabaseBrowserClient()),
  markSignedIn: () => {
    try {
      window.localStorage.setItem(SIGNED_IN_FLAG_KEY, "1");
    } catch {
      /* ignore */
    }
  },
});

/**
 * Renews Supabase auth on resume so mobile Safari and the Capacitor shell do not
 * drop back to sign-in after backgrounding.
 */
export function PortalSessionKeepalive() {
  useEffect(() => {
    let disposed = false;
    const supabase = createSupabaseBrowserClient();
    const { data: authListener } = supabase.auth.onAuthStateChange((event: AuthChangeEvent, session: Session | null) => {
      if (disposed) return;
      if (event === "INITIAL_SESSION") {
        portalSessionRefresh.observeInitialSession(session);
        return;
      }
      portalSessionRefresh.observeAuthLifecycle(session);
    });

    void portalSessionRefresh.refresh();

    const onVisible = () => {
      if (!disposed && document.visibilityState === "visible") {
        void portalSessionRefresh.refresh();
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    let removeResume: (() => void) | undefined;
    if (detectNativePlatformSync()) {
      void import("@capacitor/app")
        .then(({ App }) =>
          App.addListener("resume", () => {
            if (!disposed) void portalSessionRefresh.refresh();
          }),
        )
        .then((handle) => {
          if (disposed) {
            void handle.remove();
            return;
          }
          removeResume = () => void handle.remove();
        })
        .catch(() => undefined);
    }

    return () => {
      disposed = true;
      portalSessionRefresh.invalidate();
      document.removeEventListener("visibilitychange", onVisible);
      authListener.subscription.unsubscribe();
      removeResume?.();
    };
  }, []);

  return null;
}
