"use client";

import posthog from "posthog-js";
import { AuthCard } from "@/components/auth/auth-card";
import { AuthBrandHeader, AuthDivider, AuthLegalConsent } from "@/components/auth/auth-mobile-primitives";
import { OAuthSocialStack } from "@/components/auth/oauth-social-stack";
import { SignupFieldStack } from "@/components/auth/signup-field-stack";
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
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { recoverImplicitAuthHash } from "@/lib/auth/recover-implicit-auth-hash";
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
import { normalizeAuthEmail } from "@/lib/auth/normalize-auth-email";

const LOGIN_TIMEOUT_MS = 6000;
/** Hub signup can lag GoTrue propagation; retries need a longer ceiling than sign-in. */
const SIGNUP_SIGNIN_TIMEOUT_MS = 15_000;

type SignInResult = {
  data: { user: { id: string } | null; session: unknown | null };
  error: { message: string } | null;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function signInAfterSignup(
  supabase: ReturnType<typeof createSupabaseBrowserClient>,
  email: string,
  password: string,
): Promise<SignInResult> {
  let last: SignInResult = { data: { user: null, session: null }, error: { message: "Sign-in failed" } };
  for (let attempt = 0; attempt < 4; attempt++) {
    last = (await supabase.auth.signInWithPassword({
      email: normalizeAuthEmail(email),
      password,
    })) as SignInResult;
    if (last.data.user && !last.error) return last;
    if (attempt < 3) await sleep(350 * (attempt + 1));
  }
  return last;
}

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
  // "Invalid login credentials" is Supabase's raw string and is not how the rest
  // of the product speaks; it also routes nowhere, so someone whose account does
  // not exist has no way to tell that from a typo (PRP-189).
  //
  // It deliberately stays AMBIGUOUS between "wrong password" and "no such
  // account". Distinguishing them would make this form an account-existence
  // oracle, which is the exact property `POST /api/auth/password-reset` answers
  // `{ok:true}` for unknown addresses to avoid. What changes is that it now
  // speaks plainly and names both ways forward, and the form renders those as
  // real links beneath it.
  if (lower.includes("invalid login credentials")) {
    return "That email and password don't match an account. Check the password, or create an account if you don't have one yet.";
  }
  if (lower.includes("email not confirmed")) {
    return "This account hasn't been confirmed yet. Check your email for the confirmation link.";
  }
  return raw;
}

/** Whether the failure is one where "reset it" / "create one" are the next steps. */
export function authErrorOffersAccountRoutes(message: string | null | undefined): boolean {
  return (message ?? "").includes("don't match an account");
}

function withTimeout<T>(promise: PromiseLike<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId = 0;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(() => reject(new AuthTimeoutError(message)), timeoutMs);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => window.clearTimeout(timeoutId));
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

/**
 * The single account-CREATION surface, reached only from
 * /auth/create-account (role picked before it, or carried on `?role=`).
 *
 * It used to serve sign-in too, behind `mode` and `variant` props, and carried a
 * second full copy of the fields for the layout no caller asked for. Sign-in
 * moved to NativeAuthHub, so those branches had no route into them — and the
 * unreachable copy had already drifted, losing the phone input the live one
 * collects. Both are gone; role and plan are still resolved AFTER
 * authentication, so this screen has no role toggle and no plan selection.
 */
export function PortalAuthForm() {
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
  useAuthWelcomeChrome(true);

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
    /* eslint-disable react-hooks/set-state-in-effect -- one-time hydration from the URL */
    if (emailFromUrl) setEmail((cur) => cur || emailFromUrl);
    if (nameFromUrl) setFullName((cur) => cur || nameFromUrl);
    if (phoneFromUrl) setPhone((cur) => cur || phoneFromUrl);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [emailFromUrl, nameFromUrl, phoneFromUrl]);

  useEffect(() => {
    if (!prospectHandoffSnapshot) return;
    persistProspectHandoff(prospectHandoffSnapshot);
  }, [prospectHandoffSnapshot]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const supabase = createSupabaseBrowserClient();
      const { recovered } = await recoverImplicitAuthHash(supabase);
      if (cancelled || !recovered) return;
      setErrorText(null);
      window.location.replace(continueHref(nextPath));
    })();
    return () => {
      cancelled = true;
    };
  }, [nextPath]);

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
            email: normalizeAuthEmail(email),
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
          supabase.auth.signInWithPassword({ email: normalizeAuthEmail(email), password }) as PromiseLike<SignInResult>,
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
        body: JSON.stringify({
          email: normalizeAuthEmail(email),
          password,
          fullName: fullName.trim() || undefined,
          // Was collected into state and then dropped on the floor here.
          phone: phone.trim() || undefined,
        }),
      });
      const body = (await res.json()) as { error?: string; existingAccount?: boolean };
      if (!res.ok) {
        setErrorText(body.error ?? "Could not create your account.");
        return;
      }
      const supabase = createSupabaseBrowserClient();
      const { data, error } = await withTimeout(
        signInAfterSignup(supabase, normalizeAuthEmail(email), password),
        SIGNUP_SIGNIN_TIMEOUT_MS,
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

  const submit = handleCreate;

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

  const stackClassName = "native-auth-hub-stack mx-auto w-full max-w-[52rem] self-center";

  const fields = (
    <div className="space-y-3">
      <SignupFieldStack
        values={{ fullName, email, phone, password }}
        onChange={(patch) => {
          if (patch.fullName !== undefined) setFullName(patch.fullName);
          if (patch.email !== undefined) setEmail(patch.email);
          if (patch.phone !== undefined) setPhone(patch.phone);
          if (patch.password !== undefined) setPassword(patch.password);
        }}
        disabled={busy}
        // A prospect handoff carries the address off the tour request; letting it
        // be edited here would sign the person up as somebody else.
        emailDisabled={prospectHandoff && Boolean(emailFromUrl)}
        phonePlaceholder={tourInquiryFromUrl ? "Phone from your tour request" : undefined}
        onSubmit={() => void submit()}
      />
    </div>
  );

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
                /*
                 * The role the user picked to GET here (`?role=manager` from the
                 * public nav, `role=resident` from an apply or tour link) is the
                 * answer to "which account do you want" — so it has to survive the
                 * Google round trip, or the far side asks again. Only the prospect
                 * handoff used to set an intent, so every other role-carrying entry
                 * arrived at the chooser with nothing (AXI-126 / AXI-152).
                 */
                intent={prospectHandoff ? "resident" : pickerRoleFromParam(roleFromUrl)}
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
              {fields}
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
