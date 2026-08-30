"use client";

import { OAUTH_GOOGLE_BUTTON_CLASS } from "@/components/auth/oauth-social-styles";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { startOAuthSignIn } from "@/lib/auth/start-oauth-sign-in";
import type { OAuthSignInIntent } from "@/lib/auth/post-oauth-routing";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { useEffect, useState } from "react";

function GoogleGlyph() {
  return (
    <svg className="h-5 w-5 shrink-0" viewBox="0 0 24 24" aria-hidden>
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  );
}

export function GoogleSignInButton({
  nextPath = "",
  disabled = false,
  label = "Continue with Google",
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

  const signInWithGoogle = async () => {
    setBusy(true);
    onError?.("");
    const supabase = createSupabaseBrowserClient();
    const result = await startOAuthSignIn({
      supabase,
      provider: "google",
      nextPath,
      viaContinue,
      fixedCallbackPath,
      intent,
      onBeforeRedirect,
    });
    if (!result.ok) {
      if (onError) {
        onError(result.message);
      } else {
        showToast(result.message);
      }
      setBusy(false);
      return;
    }
    window.setTimeout(() => setBusy(false), 90_000);
  };

  return (
    <button
      type="button"
      onClick={() => void signInWithGoogle()}
      disabled={disabled || busy}
      data-attr="auth-google-sign-in"
      className={OAUTH_GOOGLE_BUTTON_CLASS}
    >
      <GoogleGlyph />
      {busy ? "Redirecting…" : label}
    </button>
  );
}
