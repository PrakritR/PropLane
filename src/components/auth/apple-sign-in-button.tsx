"use client";

import { OAUTH_APPLE_BUTTON_CLASS } from "@/components/auth/oauth-social-styles";
import { useAppUi } from "@/components/providers/app-ui-provider";
import {
  appleWebOAuthRedirectUrl,
  isAppleSignInAvailable,
  logAppleSignInUnavailableDevHint,
  resolveAppleWebOAuthSignIn,
  shouldShowAppleSignInErrorToast,
} from "@/lib/auth/apple-sign-in-config";
import { startAppleSignIn } from "@/lib/auth/start-apple-sign-in";
import { canUseNativeAppleSignIn } from "@/lib/auth/native-apple-sign-in";
import { resolveOAuthBrowserOrigin } from "@/lib/auth/password-reset-url";
import type { OAuthSignInIntent } from "@/lib/auth/post-oauth-routing";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { useEffect, useRef, useState } from "react";

function AppleGlyph({ className = "h-5 w-5 shrink-0" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden fill="currentColor">
      <path d="M17.05 20.28c-.98.95-2.05.88-3.08.4-1.09-.5-2.08-.48-3.24 0-1.44.62-2.2.44-3.06-.4C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09l.01-.01zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
    </svg>
  );
}

export function AppleSignInButton({
  nextPath = "",
  disabled = false,
  label = "Continue with Apple",
  viaContinue = true,
  fixedCallbackPath,
  intent = null,
  onBeforeRedirect,
  onError,
}: {
  nextPath?: string;
  disabled?: boolean;
  label?: string;
  viaContinue?: boolean;
  fixedCallbackPath?: string;
  intent?: OAuthSignInIntent | null;
  onBeforeRedirect?: () => void;
  /** Prefer an in-place failure slot; toast only when the caller has nowhere else to put it. */
  onError?: (message: string) => void;
}) {
  const { showToast } = useAppUi();
  const [busy, setBusy] = useState(false);
  const signInInFlight = useRef(false);

  useEffect(() => {
    logAppleSignInUnavailableDevHint();
    if (!isAppleSignInAvailable() || canUseNativeAppleSignIn()) return;

    let cancelled = false;
    void (async () => {
      try {
        const supabase = createSupabaseBrowserClient();
        const origin = resolveOAuthBrowserOrigin();
        const redirectTo = appleWebOAuthRedirectUrl(origin, fixedCallbackPath);
        const result = await resolveAppleWebOAuthSignIn(supabase, redirectTo);
        if (!cancelled && !result.ok && process.env.NODE_ENV !== "production") {
          console.info(`[Apple Sign In] Web OAuth probe: ${result.message}`);
        }
      } catch (err) {
        if (!cancelled && process.env.NODE_ENV !== "production") {
          console.info("[Apple Sign In] Skipping web OAuth probe:", err instanceof Error ? err.message : err);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fixedCallbackPath]);

  useEffect(() => {
    if (!busy) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        window.setTimeout(() => setBusy(false), 400);
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [busy]);

  if (!isAppleSignInAvailable()) return null;

  const signInWithApple = async () => {
    if (signInInFlight.current) return;
    signInInFlight.current = true;
    setBusy(true);
    onError?.("");
    try {
      const supabase = createSupabaseBrowserClient();
      const result = await startAppleSignIn({
        supabase,
        provider: "apple",
        nextPath,
        viaContinue,
        fixedCallbackPath,
        intent,
        onBeforeRedirect,
      });
      if (!result.ok) {
        // Cancellation is silent — no inline text AND no toast. Dismissing a sheet is not a
        // problem, and telling the user something broke when nothing did is wrong. This is the
        // same answer `openOAuthUrl` gives for the WebAuthSession `CANCELED` code; Apple and
        // Google must not answer the same question two different ways on the same screen.
        if (!result.cancelled) {
          if (onError) {
            onError(result.message);
          } else if (shouldShowAppleSignInErrorToast(result.message)) {
            showToast(result.message);
          }
        }
        setBusy(false);
        return;
      }
      if (!canUseNativeAppleSignIn()) {
        window.setTimeout(() => setBusy(false), 90_000);
      } else {
        setBusy(false);
      }
    } finally {
      signInInFlight.current = false;
    }
  };

  return (
    <button
      type="button"
      onClick={() => void signInWithApple()}
      disabled={disabled || busy}
      data-attr="auth-apple-sign-in"
      className={OAUTH_APPLE_BUTTON_CLASS}
    >
      <AppleGlyph />
      {busy ? (canUseNativeAppleSignIn() ? "Signing in…" : "Redirecting…") : label}
    </button>
  );
}
