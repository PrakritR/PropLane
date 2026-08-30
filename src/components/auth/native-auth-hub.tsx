"use client";

import { AuthCard } from "@/components/auth/auth-card";
import {
  AuthBrandHeader,
  AuthDivider,
  AuthLegalConsent,
  AuthLoadingCard,
} from "@/components/auth/auth-mobile-primitives";
import { OAuthSocialStack } from "@/components/auth/oauth-social-stack";
import { useAuthWelcomeChrome } from "@/components/auth/use-auth-welcome-chrome";
import { useIsNativeApp } from "@/hooks/use-is-native-app";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { resolveFormCredentials } from "@/lib/auth/form-credentials";
import { oauthErrorFromParams } from "@/lib/auth/oauth-error-params";
import { oauthContinuePath } from "@/lib/auth/oauth-redirect";
import { isUnsafeRedirectPath } from "@/lib/auth/normalize-post-auth-path";
import {
  parseOAuthSignInIntent,
  resolveSignInNextPath,
} from "@/lib/auth/post-oauth-routing";
import { detectNativePlatformSync } from "@/lib/native/detect-native";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { waitForOAuthUser } from "@/lib/auth/wait-for-oauth-user";
import { isNativeOAuthInProgress } from "@/lib/native/open-url";
import { getNativeInfo } from "@/lib/native/push-client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

async function tryResidentAutoConfirm(email: string): Promise<boolean> {
  try {
    const res = await fetch("/api/auth/confirm-resident-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.trim() }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function readRememberedLoginEmail(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem("axis:remembered-login-email") ?? "";
  } catch {
    return "";
  }
}

/** Role-agnostic create-account URL — portal type is chosen on /auth/get-started after signup. */
function buildCreateAccountHref(searchParams: URLSearchParams): string {
  const params = new URLSearchParams();
  const next = searchParams.get("next")?.trim() ?? "";
  if (next && !isUnsafeRedirectPath(next)) params.set("next", next);
  const tourInquiry = searchParams.get("tour_inquiry")?.trim() ?? "";
  if (tourInquiry) params.set("tour_inquiry", tourInquiry);
  const handoff = searchParams.get("handoff")?.trim() ?? "";
  if (handoff === "message") params.set("handoff", "message");
  const email = searchParams.get("email")?.trim() ?? "";
  if (email) params.set("email", email);
  const name = searchParams.get("name")?.trim() ?? "";
  if (name) params.set("name", name);
  const phone = searchParams.get("phone")?.trim() ?? "";
  if (phone) params.set("phone", phone);
  if (tourInquiry || handoff === "message") params.set("role", "resident");
  const qs = params.toString();
  return qs ? `/auth/create-account?${qs}` : "/auth/create-account";
}

type NativeAuthHubProps = {
  /** @deprecated Create-account uses /auth/create-account; kept for vendor-register invite redirects. */
  defaultMode?: "sign-in" | "create";
};

function NativeAuthHubInner({ defaultMode = "sign-in" }: NativeAuthHubProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  useAuthWelcomeChrome(true);
  const { isNative } = useIsNativeApp();

  const [checkingSession, setCheckingSession] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  // `/auth/sign-in` is where EVERY native OAuth failure lands (`nativeOAuthSignInFailureUrl`
  // navigates here with ?error=oauth&message=…). Reading those params is what turns that
  // navigation from a bare page reload — "it just refreshes and goes back" — into an
  // explanation. `PortalAuthForm` already did this; this screen dropped it on the floor.
  const [errorText, setErrorText] = useState<string | null>(() =>
    oauthErrorFromParams(searchParams),
  );
  const [failedSignInAttempts, setFailedSignInAttempts] = useState(0);

  const nextFromUrl = searchParams.get("next")?.trim() ?? "";
  const signInIntent = parseOAuthSignInIntent(
    searchParams.get("intent") ?? searchParams.get("role"),
  );
  const signInNextPath = useMemo(
    () => resolveSignInNextPath(nextFromUrl, signInIntent),
    [nextFromUrl, signInIntent],
  );
  const signInContinueHref = useMemo(() => oauthContinuePath(signInNextPath), [signInNextPath]);
  const createAccountHref = useMemo(() => buildCreateAccountHref(searchParams), [searchParams]);

  useEffect(() => {
    const remembered = readRememberedLoginEmail();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time hydration from stored login on mount
    if (remembered) setEmail(remembered);
  }, []);

  // Legacy deep links (?mode=create) → unified create-account.
  useEffect(() => {
    if (defaultMode !== "create" && searchParams.get("mode") !== "create") return;
    router.replace(createAccountHref);
  }, [createAccountHref, defaultMode, router, searchParams]);

  useEffect(() => {
    if (!detectNativePlatformSync()) {
      setCheckingSession(false);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const { isNative } = await getNativeInfo();
        if (!isNative || cancelled) return;
        if (isNativeOAuthInProgress()) {
          return;
        }
        const supabase = createSupabaseBrowserClient();
        const user = await waitForOAuthUser(supabase, { attempts: 4, delayMs: 200 });
        if (!cancelled && user) {
          window.location.replace(signInContinueHref);
        }
      } finally {
        if (!cancelled) setCheckingSession(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [signInContinueHref]);

  useEffect(() => {
    if (checkingSession) return;

    const redirectAfterOAuth = async () => {
      if (!isNativeOAuthInProgress()) return;
      const supabase = createSupabaseBrowserClient();
      const user = await waitForOAuthUser(supabase, { attempts: 6, delayMs: 200 });
      if (user) window.location.replace(signInContinueHref);
    };

    const onVisible = () => {
      if (document.visibilityState === "visible") void redirectAfterOAuth();
    };

    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [checkingSession, signInContinueHref]);

  const formRef = useRef<HTMLFormElement | null>(null);

  /**
   * iOS/iPadOS Password AutoFill writes straight into the input's DOM value, and
   * WebKit does not always deliver that to React as a change event — so the box
   * visibly holds the password while `password` state is still "". Reading state
   * alone then refused the sign-in with "Enter email and password." over
   * credentials the user could plainly see, which is how App Review hit an error
   * message immediately after attempting to log in (Guideline 2.1(a), build 69,
   * reviewed on iPad).
   *
   * The DOM is authoritative here because it is what the person actually sees —
   * for the email as much as the password, since a remembered email is seeded
   * into state on mount and AutoFilling another saved account would otherwise
   * submit that stale email with the new password.
   */
  const credentialsFromDom = () => {
    const form = formRef.current;
    const domEmail = (form?.elements.namedItem("email") as HTMLInputElement | null)?.value ?? "";
    const domPassword =
      (form?.elements.namedItem("password") as HTMLInputElement | null)?.value ?? "";
    return resolveFormCredentials({
      domEmail,
      domPassword,
      stateEmail: email,
      statePassword: password,
    });
  };

  const signIn = async () => {
    const credentials = credentialsFromDom();
    if (!credentials.email || !credentials.password) {
      setErrorText("Enter email and password.");
      return;
    }
    // Re-sync state so a later retry, and the remembered-email write below, see
    // what was autofilled.
    if (credentials.email !== email.trim()) setEmail(credentials.email);
    if (credentials.password !== password) setPassword(credentials.password);
    setErrorText(null);
    setBusy(true);
    try {
      const supabase = createSupabaseBrowserClient();
      let { data, error } = await supabase.auth.signInWithPassword({
        email: credentials.email,
        password: credentials.password,
      });
      if (error?.message.toLowerCase().includes("email not confirmed")) {
        const repaired = await tryResidentAutoConfirm(credentials.email);
        if (repaired) {
          const retry = await supabase.auth.signInWithPassword({
            email: credentials.email,
            password: credentials.password,
          });
          data = retry.data;
          error = retry.error;
        }
      }
      if (error) {
        setErrorText(error.message);
        setFailedSignInAttempts((n) => n + 1);
        return;
      }
      if (!data.user) throw new Error("No active session.");
      setFailedSignInAttempts(0);
      try {
        window.localStorage.setItem("axis:remembered-login-email", credentials.email);
      } catch {
        /* ignore */
      }
      window.location.replace(signInContinueHref);
    } catch (e) {
      setErrorText(e instanceof Error ? e.message : "Sign-in failed");
      setFailedSignInAttempts((n) => n + 1);
    } finally {
      setBusy(false);
    }
  };

  const openCreateAccount = useCallback(() => {
    router.push(createAccountHref);
  }, [createAccountHref, router]);

  const locked = busy;
  const showForgotPassword = failedSignInAttempts >= 2;

  if (checkingSession) {
    return (
      <div className="native-auth-hub-stack mx-auto w-full max-w-[460px]" data-auth-mode="sign-in">
        <AuthCard variant="blend">
          {isNative ? (
            <div className="auth-brand-header-wrap mb-4">
              <AuthBrandHeader homeLink />
            </div>
          ) : null}
          <AuthLoadingCard />
        </AuthCard>
      </div>
    );
  }

  return (
    <div className="native-auth-hub-stack mx-auto w-full max-w-[460px] self-center" data-auth-mode="sign-in">
      <AuthCard variant="blend">
        <div className="native-auth-hub">
          {isNative ? (
            <div className="auth-brand-header-wrap mb-4">
              <AuthBrandHeader homeLink />
            </div>
          ) : null}

          <div className="space-y-3">
            <OAuthSocialStack
              nextPath={signInNextPath}
              intent={signInIntent}
              disabled={locked}
              onError={(message) => setErrorText(message || null)}
            />
            <AuthDivider label="or enter your details" />
            {/* A real <form> with NAMED fields, not loose inputs in a div.
                iOS/iPadOS Password AutoFill and every password manager identify
                credential fields by form membership and name; without it the
                keyboard also offers "return" instead of "Go" and nothing submits.
                See `credentialsFromDom` for the other half of this fix. */}
            <form
              ref={formRef}
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                void signIn();
              }}
            >
              <Input
                id="auth-hub-email"
                name="email"
                type="email"
                autoComplete="email"
                placeholder="Email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setFailedSignInAttempts(0);
                  setErrorText(null);
                }}
                disabled={locked}
              />
              <div>
                <PasswordInput
                  id="auth-hub-password"
                  name="password"
                  autoComplete="current-password"
                  placeholder="Password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={locked}
                />
                {showForgotPassword ? (
                  <p className="mt-1.5 text-right text-[12px]">
                    <Link className="font-semibold text-primary hover:opacity-90" href="/auth/forgot-password">
                      Forgot password?
                    </Link>
                  </p>
                ) : null}
              </div>
              {errorText ? <p className="text-center text-xs text-rose-600">{errorText}</p> : null}
              <Button
                type="submit"
                className="btn-cobalt w-full rounded-full py-2.5 text-[15px] font-semibold"
                disabled={locked}
                loading={busy}
              >
                {busy ? "Signing in…" : "Sign in"}
              </Button>
            </form>
          </div>
        </div>
      </AuthCard>

      <div className="native-auth-hub-footer relative z-10 mt-5 space-y-3 text-center text-[12px]">
        <p className="text-muted">
          Don&apos;t have an account?{" "}
          {isNative ? (
            <button
              type="button"
              onClick={openCreateAccount}
              data-attr="auth-hub-create-account"
              className="font-semibold text-primary hover:opacity-90"
            >
              Create your account
            </button>
          ) : (
            <Link
              className="font-semibold text-primary hover:opacity-90"
              href={createAccountHref}
              data-attr="auth-hub-create-account"
            >
              Create your account
            </Link>
          )}
        </p>
        <AuthLegalConsent action="continue" className="px-1" />
        <p className="native-hide text-muted">
          <Link href="/app" className="font-semibold text-primary hover:opacity-90" data-attr="auth-hub-mobile-app">
            PropLane mobile app
          </Link>
        </p>
      </div>
    </div>
  );
}

export function NativeAuthHub(props: NativeAuthHubProps = {}) {
  return (
    <Suspense
      fallback={
        <div className="native-auth-hub-stack mx-auto w-full max-w-[460px]" data-auth-mode="sign-in">
          <AuthCard variant="blend">
            <AuthLoadingCard />
          </AuthCard>
        </div>
      }
    >
      <NativeAuthHubInner {...props} />
    </Suspense>
  );
}
