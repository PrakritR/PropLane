"use client";

import posthog from "posthog-js";
import { AuthCard } from "@/components/auth/auth-card";
import { AuthBrandHeader, AuthDivider, AuthLegalConsent, AuthPageHeader } from "@/components/auth/auth-mobile-primitives";
import { OAuthSocialStack } from "@/components/auth/oauth-social-stack";
import { oauthErrorFromParams } from "@/lib/auth/oauth-error-params";
import {
  AUTH_PORTAL_PICKER_OPTIONS,
  type AuthPortalPickerId,
} from "@/lib/auth/auth-portal-picker-options";
import { navigateAfterRoleSignup } from "@/lib/auth/navigate-after-role-signup";
import { provisionPortalFromGetStarted } from "@/lib/auth/provision-portal-from-get-started";
import { safeNextPath } from "@/lib/auth/safe-next-path";
import { markPortalSessionActive } from "@/lib/auth/portal-session-gate";
import { useAuthWelcomeChrome } from "@/components/auth/use-auth-welcome-chrome";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { useIsNativeApp } from "@/hooks/use-is-native-app";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { waitForOAuthUser } from "@/lib/auth/wait-for-oauth-user";
import { isNativeOAuthInProgress } from "@/lib/native/open-url";
import { portalNavClick } from "@/lib/portal-nav-client";
import { residentBrowseFromAuthHref, residentSignInHref } from "@/lib/resident-public-nav";
import {
  persistProspectHandoff,
  prospectHandoffFromSearchParams,
} from "@/lib/auth/prospect-handoff-storage";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

const LOGIN_TIMEOUT_MS = 6000;
const REMEMBERED_EMAIL_KEY = "axis:remembered-login-email";

type SignInResult = {
  data: { user: { id: string } | null; session: unknown | null };
  error: { message: string } | null;
};

class AuthTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthTimeoutError";
  }
}

function friendlyAuthError(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes("failed to fetch") || lower.includes("network") || lower.includes("fetch")) {
    return "We could not reach PropLane. Please check your connection and try again.";
  }
  if (raw.includes("NEXT_PUBLIC_SUPABASE")) return "PropLane auth is not configured. Set env vars in .env.local.";
  return raw;
}

function withTimeout<T>(promise: PromiseLike<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId = 0;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(() => reject(new AuthTimeoutError(message)), timeoutMs);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => window.clearTimeout(timeoutId));
}

function readRememberedEmail(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(REMEMBERED_EMAIL_KEY) ?? "";
  } catch {
    return "";
  }
}

function continueHref(nextPath: string): string {
  const safe = safeNextPath(nextPath);
  if (!safe) return "/auth/continue";
  return `/auth/continue?next=${encodeURIComponent(safe)}`;
}

/** Carries the destination through the role chooser so a detour does not lose it. */
function getStartedHref(nextPath: string | null): string {
  if (!nextPath) return "/auth/get-started";
  return `/auth/get-started?next=${encodeURIComponent(nextPath)}`;
}

/** `?role=` is user-supplied — only the three real portal ids are honoured. */
function pickerRoleFromParam(value: string): AuthPortalPickerId | null {
  return AUTH_PORTAL_PICKER_OPTIONS.some((opt) => opt.id === value)
    ? (value as AuthPortalPickerId)
    : null;
}

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

/**
 * The single portal auth surface for every account type — one clean screen used by both
 * /auth/sign-in and /auth/create-account, web and native. Role and plan are resolved
 * AFTER authentication (the single engine + /auth/get-started chooser), so this screen
 * has no role toggle, no plan selection, and no "change role" affordance.
 */
export function PortalAuthForm({
  mode,
  variant = "default",
}: {
  mode: "sign-in" | "create";
  /** Hub layout matches the legacy NativeAuthHub create surface (placeholders, no role toggle). */
  variant?: "default" | "hub";
}) {
  const router = useRouter();
  const { showToast } = useAppUi();
  const { isNative } = useIsNativeApp();
  const searchParams = useSearchParams();
  const nextPath = searchParams.get("next") ?? "";
  // `?role=` names the portal the user was already heading into (e.g. the apply
  // flow links to `role=resident&next=/resident/applications/apply?...`).
  // Honouring it skips the "How do you want to use PropLane?" chooser, which
  // otherwise discards BOTH the role and the destination and strands a prospect
  // who was mid-application.
  const roleFromUrl = searchParams.get("role")?.trim().toLowerCase() ?? "";
  const emailFromUrl = searchParams.get("email")?.trim().toLowerCase() ?? "";
  const nameFromUrl = searchParams.get("name")?.trim() ?? "";
  const phoneFromUrl = searchParams.get("phone")?.trim() ?? "";
  const tourInquiryFromUrl = searchParams.get("tour_inquiry")?.trim() ?? "";
  const handoffFromUrl = searchParams.get("handoff")?.trim() ?? "";
  const prospectHandoff = Boolean(tourInquiryFromUrl) || handoffFromUrl === "message";
  const prospectHandoffSnapshot = useMemo(
    () => prospectHandoffFromSearchParams(searchParams),
    [searchParams],
  );
  const isCreate = mode === "create";
  const isHub = variant === "hub";
  useAuthWelcomeChrome(isCreate);

  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  // Surface any OAuth callback error passed back via ?error=oauth&message=...
  const [errorText, setErrorText] = useState<string | null>(() =>
    oauthErrorFromParams(searchParams),
  );

  useEffect(() => {
    if (!isCreate) return;
    if (emailFromUrl) setEmail((cur) => cur || emailFromUrl);
    if (nameFromUrl) setFullName((cur) => cur || nameFromUrl);
    if (phoneFromUrl) setPhone((cur) => cur || phoneFromUrl);
  }, [emailFromUrl, isCreate, nameFromUrl, phoneFromUrl]);

  useEffect(() => {
    if (!prospectHandoffSnapshot) return;
    persistProspectHandoff(prospectHandoffSnapshot);
  }, [prospectHandoffSnapshot]);

  useEffect(() => {
    if (isCreate) return;
    const remembered = readRememberedEmail();
    if (remembered) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time hydration from stored login
      setEmail(remembered);
    }
  }, [isCreate]);

  // Native shell returns to this screen after the OAuth browser tab closes; finish routing.
  useEffect(() => {
    const redirectAfterOAuth = async () => {
      if (!isNativeOAuthInProgress()) return;
      const supabase = createSupabaseBrowserClient();
      const user = await waitForOAuthUser(supabase, { attempts: 6, delayMs: 200 });
      if (user) window.location.replace("/auth/continue");
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void redirectAfterOAuth();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  const handleSignIn = async () => {
    if (!email.trim() || !password) {
      setErrorText("Enter email and password.");
      return;
    }
    setErrorText(null);
    setBusy(true);
    let didRedirect = false;
    try {
      const supabase = createSupabaseBrowserClient();
      let authResult = await withTimeout(
        supabase.auth.signInWithPassword({ email: email.trim(), password }) as PromiseLike<SignInResult>,
        LOGIN_TIMEOUT_MS,
        "Login is taking too long. Please check your connection and try again.",
      );
      if (authResult.error?.message.toLowerCase().includes("email not confirmed")) {
        if (await tryResidentAutoConfirm(email)) {
          authResult = await withTimeout(
            supabase.auth.signInWithPassword({ email: email.trim(), password }) as PromiseLike<SignInResult>,
            LOGIN_TIMEOUT_MS,
            "Login is taking too long. Please check your connection and try again.",
          );
        }
      }
      if (authResult.error) {
        setErrorText(friendlyAuthError(authResult.error.message));
        return;
      }
      const user = authResult.data.user;
      if (!user) throw new Error("No active session.");
      posthog.identify(user.id);
      try {
        window.localStorage.setItem(REMEMBERED_EMAIL_KEY, email.trim());
      } catch {
        /* ignore */
      }
      await supabase.auth.refreshSession().catch(() => undefined);
      await supabase.auth.getSession();
      didRedirect = true;
      window.location.replace(continueHref(nextPath));
    } catch (e) {
      setErrorText(friendlyAuthError(e instanceof Error ? e.message : "Sign-in failed"));
    } finally {
      if (!didRedirect) setBusy(false);
    }
  };

  const handleCreate = async () => {
    if (!email.trim() || password.length < 8) {
      setErrorText("Enter your email and a password of at least 8 characters.");
      return;
    }
    if (prospectHandoff && tourInquiryFromUrl && !phone.trim()) {
      setErrorText("Enter the phone number you used on your tour request.");
      return;
    }
    setErrorText(null);
    setBusy(true);
    let didRedirect = false;
    try {
      if (prospectHandoff) {
        const res = await fetch("/api/auth/tour-resident-register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: email.trim(),
            password,
            fullName: fullName.trim() || undefined,
            phone: phone.trim() || undefined,
            tourInquiryId: tourInquiryFromUrl || undefined,
            handoff: handoffFromUrl === "message" ? "message" : undefined,
          }),
        });
        const body = (await res.json().catch(() => ({}))) as { error?: string; redirectTo?: string };
        if (!res.ok) {
          setErrorText(body.error ?? "Could not create your account.");
          return;
        }
        const supabase = createSupabaseBrowserClient();
        const { data, error } = await withTimeout(
          supabase.auth.signInWithPassword({ email: email.trim(), password }) as PromiseLike<SignInResult>,
          LOGIN_TIMEOUT_MS,
          "This is taking too long. Please check your connection and try again.",
        );
        if (error || !data.user) {
          showToast("Account created. Sign in to continue.");
          window.location.replace("/auth/sign-in");
          return;
        }
        posthog.identify(data.user.id);
      markPortalSessionActive();
        didRedirect = true;
        window.location.replace(
          body.redirectTo?.startsWith("/") ? body.redirectTo : "/resident/tour/pending",
        );
        return;
      }

      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password, fullName: fullName.trim() || undefined }),
      });
      const body = (await res.json()) as { error?: string; existingAccount?: boolean };
      if (!res.ok) {
        setErrorText(body.error ?? "Could not create your account.");
        return;
      }
      const supabase = createSupabaseBrowserClient();
      const { data, error } = await withTimeout(
        supabase.auth.signInWithPassword({ email: email.trim(), password }) as PromiseLike<SignInResult>,
        LOGIN_TIMEOUT_MS,
        "This is taking too long. Please check your connection and try again.",
      );
      if (error || !data.user) {
        showToast("Account created. Sign in to continue.");
        window.location.replace("/auth/sign-in");
        return;
      }
      posthog.identify(data.user.id);
      markPortalSessionActive();
      didRedirect = true;
      // Existing accounts already have a role — resolve it; brand-new accounts have none
      // and land on the role chooser via the single engine.
      if (body.existingAccount) {
        window.location.replace(continueHref(safeNextPath(nextPath) ?? ""));
        return;
      }
      // A brand-new account that arrived WITH a role (the apply / tour funnels)
      // provisions it here and continues to where it was going. Falling through
      // to the chooser used to throw away both, dropping a prospect who clicked
      // "Apply for this property" onto a generic "how do you want to use
      // PropLane?" screen with their application abandoned.
      const requestedRole = pickerRoleFromParam(roleFromUrl);
      if (requestedRole) {
        const provisioned = await provisionPortalFromGetStarted(requestedRole);
        if (provisioned.ok) {
          const destination = safeNextPath(nextPath);
          if (destination) {
            window.location.replace(destination);
            return;
          }
          if (provisioned.direct) {
            window.location.replace(provisioned.redirectTo);
            return;
          }
          await navigateAfterRoleSignup(provisioned.redirectTo);
          return;
        }
        // Provisioning failed — fall through to the chooser rather than
        // stranding the user, but keep the destination so it survives the detour.
      }
      window.location.replace(getStartedHref(safeNextPath(nextPath)));
    } catch (e) {
      setErrorText(friendlyAuthError(e instanceof Error ? e.message : "Sign up failed"));
    } finally {
      if (!didRedirect) setBusy(false);
    }
  };

  const submit = isCreate ? handleCreate : handleSignIn;

  const browseHomesHref = residentBrowseFromAuthHref();
  const onBrowseHomesClick = useMemo(
    () => portalNavClick(router, browseHomesHref, { preferFullNavigation: true }),
    [browseHomesHref, router],
  );

  const oauthNextPath =
    nextPath ||
    (prospectHandoffSnapshot?.nextPath?.startsWith("/") ? prospectHandoffSnapshot.nextPath : "");

  const prospectSignInHref = prospectHandoff
    ? residentSignInHref(
        oauthNextPath || "/resident/tour/pending",
        {
          tourInquiryId: tourInquiryFromUrl || undefined,
          email: emailFromUrl || undefined,
          fullName: nameFromUrl || undefined,
          phone: phoneFromUrl || undefined,
        },
      )
    : "/auth/sign-in";

  const stackClassName = `native-auth-hub-stack mx-auto w-full self-center ${isHub && isCreate ? "max-w-[52rem]" : "max-w-[460px]"}`;

  const hubFields = (
    <div className="space-y-3">
      {isCreate ? (
        <Input
          autoComplete="name"
          placeholder="Full name"
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          disabled={busy}
        />
      ) : null}
      <Input
        type="email"
        autoComplete="email"
        placeholder="Email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        disabled={busy}
        readOnly={prospectHandoff && Boolean(emailFromUrl)}
      />
      {prospectHandoff ? (
        <Input
          type="tel"
          autoComplete="tel"
          placeholder={tourInquiryFromUrl ? "Phone from your tour request" : "Phone (optional)"}
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          disabled={busy}
        />
      ) : null}
      <PasswordInput
        autoComplete={isCreate ? "new-password" : "current-password"}
        placeholder={isCreate ? "Password (8+ characters)" : "Password"}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        disabled={busy}
        onKeyDown={(e) => {
          if (e.key === "Enter") void submit();
        }}
      />
    </div>
  );

  const labeledFields = (
    <div className="space-y-3 sm:space-y-4">
      {isCreate ? (
        <div>
          <label className="text-xs font-semibold text-muted" htmlFor="full-name">
            Full name
          </label>
          <Input
            id="full-name"
            className="mt-1.5"
            autoComplete="name"
            placeholder="Your name"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            disabled={busy}
          />
        </div>
      ) : null}
      <div>
        <label className="text-xs font-semibold text-muted" htmlFor="email">
          Email
        </label>
        <Input
          id="email"
          className="mt-1.5"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={busy}
        />
      </div>
      <div>
        <label className="text-xs font-semibold text-muted" htmlFor="password">
          {isCreate ? "Create password" : "Password"}
        </label>
        <PasswordInput
          id="password"
          className="mt-1.5"
          autoComplete={isCreate ? "new-password" : "current-password"}
          placeholder={isCreate ? "Minimum 8 characters" : undefined}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
        />
      </div>
    </div>
  );

  if (isHub && isCreate) {
    return (
      <div className={stackClassName} data-auth-mode="create-compact">
        <AuthCard variant="blend" wide>
          <div className="native-auth-hub">
            {isNative ? (
              <div className="auth-brand-header-wrap mb-4">
                <AuthBrandHeader homeLink />
              </div>
            ) : null}

            <div className="space-y-3">
              <OAuthSocialStack
                nextPath={oauthNextPath}
                disabled={busy}
                intent={prospectHandoff ? "resident" : null}
                viaContinue={!prospectHandoff}
                fixedCallbackPath={prospectHandoff ? "/auth/callback/resident-signup" : undefined}
                onBeforeRedirect={
                  prospectHandoffSnapshot
                    ? () => persistProspectHandoff(prospectHandoffSnapshot)
                    : undefined
                }
                onError={(message) => setErrorText(message || null)}
              />
              <AuthDivider
                label={
                  prospectHandoff
                    ? "or enter the same details you used on your tour"
                    : "or enter your details"
                }
              />
              {hubFields}
              {errorText ? <p className="text-center text-xs text-rose-600">{errorText}</p> : null}
              <Button
                type="button"
                data-attr="portal-auth-create-submit"
                className="btn-cobalt w-full rounded-full py-2.5 text-[15px] font-semibold"
                onClick={() => submit()}
                disabled={busy}
              >
                {busy ? "Creating…" : "Create account"}
              </Button>
            </div>
          </div>
        </AuthCard>

        <div className="native-auth-hub-footer relative z-10 mt-5 space-y-3 text-center text-[12px]">
          <p className="text-muted">
            Already have an account?{" "}
            <Link
              className="font-semibold text-primary hover:opacity-90"
              href={prospectSignInHref}
              data-attr="auth-hub-sign-in"
            >
              Sign in
            </Link>
          </p>
          <AuthLegalConsent action="create" className="px-1" />
          <p>
            <Link
              href={browseHomesHref}
              onClick={onBrowseHomesClick}
              data-attr="resident-browse-homes"
              className="text-sm font-semibold text-primary hover:opacity-90"
            >
              Browse homes
            </Link>
          </p>
        </div>
      </div>
    );
  }

  return (
    <AuthCard>
      <AuthPageHeader
        showLogo
        title={isCreate ? "Create your account" : "Portal sign-in"}
        subtitle={isCreate ? "One account for managers and residents" : undefined}
        accent={!isCreate}
      />

      <div className="mt-5 sm:mt-6">
        <OAuthSocialStack
          nextPath={nextPath}
          disabled={busy}
          onError={(message) => setErrorText(message || null)}
        />
      </div>

      <div className="my-4 sm:my-5">
        <AuthDivider />
      </div>

      {labeledFields}

      {!isCreate ? (
        <div className="mt-3 text-sm sm:mt-4">
          <Link className="font-semibold text-primary hover:opacity-90" href="/auth/forgot-password">
            Forgot password
          </Link>
        </div>
      ) : null}

      {errorText ? <p className="mt-4 text-center text-sm text-rose-600">{errorText}</p> : null}

      <Button
        type="button"
        className="mt-4 w-full rounded-full py-2.5 text-[15px] font-semibold sm:mt-5 sm:py-3 sm:text-base"
        onClick={() => submit()}
        disabled={busy}
      >
        {busy ? (isCreate ? "Creating…" : "Signing in…") : isCreate ? "Create account" : "Sign in"}
      </Button>

      <p className="mt-5 text-center text-[13px] text-muted sm:mt-6 sm:text-sm">
        {isCreate ? (
          <>
            Already have an account?{" "}
            <Link className="font-semibold text-primary hover:opacity-90" href="/auth/sign-in">
              Sign in
            </Link>
          </>
        ) : (
          <>
            New here?{" "}
            <Link className="font-semibold text-primary hover:opacity-90" href="/auth/create-account">
              Get started
            </Link>
          </>
        )}
      </p>

      <AuthLegalConsent action={isCreate ? "create" : "continue"} className="mt-4 sm:mt-5" />
    </AuthCard>
  );
}
