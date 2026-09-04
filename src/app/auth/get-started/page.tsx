"use client";

import { AuthCard } from "@/components/auth/auth-card";
import { AuthOAuthLoading } from "@/components/auth/auth-oauth-loading";
import {
  AuthAccountFooterLink,
  AuthBackLink,
  AuthPageHeader,
  AuthRoleStack,
} from "@/components/auth/auth-mobile-primitives";
import { useAuthWelcomeChrome } from "@/components/auth/use-auth-welcome-chrome";
import type { AuthRole } from "@/components/auth/portal-switcher";
import { useAppUi } from "@/components/providers/app-ui-provider";
import {
  AUTH_PORTAL_PICKER_OPTIONS,
  filterAddablePortalPickerOptions,
  type AuthPortalPickerId,
} from "@/lib/auth/auth-portal-picker-options";
import { isGetStartedAddMode } from "@/lib/auth/get-started-path";
import { navigateAfterRoleSignup } from "@/lib/auth/navigate-after-role-signup";
import { provisionPortalFromGetStarted } from "@/lib/auth/provision-portal-from-get-started";
import { isGetStartedDestination, resolvePostAuthDestination } from "@/lib/auth/resolve-post-auth-destination";
import { safeNextPath } from "@/lib/auth/safe-next-path";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { useRouter, useSearchParams } from "next/navigation";
import posthog from "posthog-js";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";

/**
 * Portal chooser for a signed-in user with no portal role yet (new OAuth/email login),
 * or for adding another portal type when `?mode=add`.
 */
function GetStartedContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const addMode = isGetStartedAddMode(searchParams);
  const { showToast } = useAppUi();
  const [busy, setBusy] = useState<string | null>(null);
  const [resolving, setResolving] = useState(true);
  const [existingRoles, setExistingRoles] = useState<AuthRole[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useAuthWelcomeChrome(true);

  const pickerOptions = useMemo(() => {
    if (addMode) {
      if (existingRoles === null) return [];
      return filterAddablePortalPickerOptions(existingRoles);
    }
    return AUTH_PORTAL_PICKER_OPTIONS;
  }, [addMode, existingRoles]);

  const stackOptions = useMemo(
    () =>
      pickerOptions.map((opt) => ({
        id: opt.id,
        label: opt.chooserLabel,
        hint: opt.id === "vendor" ? opt.chooserHint : undefined,
        icon: opt.icon,
        tone: opt.tone,
      })),
    [pickerOptions],
  );

  useEffect(() => {
    let cancelled = false;

    if (addMode) {
      void (async () => {
        try {
          const res = await fetch("/api/auth/portal-roles", { credentials: "include" });
          const body = (await res.json()) as { roles?: AuthRole[]; error?: string };
          if (cancelled) return;
          if (!res.ok) {
            if (res.status === 401) {
              router.replace("/auth/sign-in");
              return;
            }
            setLoadError(body.error ?? "Could not load your account.");
            setResolving(false);
            return;
          }
          setExistingRoles(body.roles ?? []);
          setResolving(false);
        } catch {
          if (!cancelled) {
            setLoadError("Could not load your account.");
            setResolving(false);
          }
        }
      })();
      return () => {
        cancelled = true;
      };
    }

    void (async () => {
      const { redirectTo, resolutionFailed } = await resolvePostAuthDestination("/auth/continue");
      if (cancelled) return;
      if (redirectTo && !isGetStartedDestination(redirectTo)) {
        window.location.replace(redirectTo);
        return;
      }
      if (resolutionFailed) {
        showToast("Couldn't verify your account. Pick an option below or sign out and try again.");
      }
      setResolving(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [addMode, router, showToast]);

  const choose = async (id: string) => {
    const role = id as AuthPortalPickerId;
    if (!pickerOptions.some((opt) => opt.id === role)) return;
    setBusy(id);
    const result = await provisionPortalFromGetStarted(role);
    if (!result.ok) {
      showToast(result.error);
      setBusy(null);
      return;
    }
    // A `?next=` forwarded from signup is where the user was actually heading
    // (e.g. an application they had already started). Honour it once the role
    // exists, rather than dropping them on a portal dashboard.
    const forwarded = safeNextPath(searchParams.get("next"));
    if (forwarded) {
      window.location.replace(forwarded);
      return;
    }
    if (result.direct) {
      // An in-flow step (the manager plan chooser) — go there verbatim; the
      // post-auth resolver would route past it to a portal dashboard.
      window.location.replace(result.redirectTo);
      return;
    }
    await navigateAfterRoleSignup(result.redirectTo);
  };

  /**
   * A role carried on the URL (`?role=resident`) means the user already told us
   * who they are — clicking through an apply or tour link, or picking Resident
   * at signup. Asking again is the complaint in AXI-152 / AXI-126.
   *
   * Only honoured for a role this chooser would actually OFFER: in add-portal
   * mode the options are the roles the account does NOT yet hold, so a param
   * naming one it already has is ignored rather than re-provisioned. Runs once —
   * `autoChoseRef` stops a re-render or a failed provision from looping.
   */
  const autoChoseRef = useRef(false);
  useEffect(() => {
    if (autoChoseRef.current || resolving || busy) return;
    const requested = searchParams.get("role")?.trim() ?? "";
    if (!requested) return;
    if (!pickerOptions.some((opt) => opt.id === requested)) return;
    autoChoseRef.current = true;
    void choose(requested);
    // `choose` is redefined every render; the ref guard is what makes this
    // one-shot, so it is deliberately not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, pickerOptions, resolving, searchParams]);


  const signOut = async () => {
    const supabase = createSupabaseBrowserClient();
    await supabase.auth.signOut();
    try {
      posthog.reset();
    } catch {
      /* best-effort analytics reset */
    }
    router.push("/auth/sign-in");
    router.refresh();
  };

  if (resolving) {
    return (
      <AuthCard variant="blend">
        <AuthOAuthLoading label={addMode ? "Loading your portals" : "Loading your account"} />
      </AuthCard>
    );
  }

  return (
    <AuthCard variant="blend">
      <AuthPageHeader
        showLogo
        title={addMode ? "Add another portal type" : "How do you want to use PropLane?"}
        subtitle={addMode ? "Same email works for every portal. Switch anytime from Settings." : undefined}
        accent={false}
      />

      {loadError ? <p className="mt-4 text-center text-sm text-rose-600">{loadError}</p> : null}

      {addMode && stackOptions.length === 0 ? (
        <p className="auth-role-stack text-center text-sm text-muted">
          You already have every portal type on this account.
        </p>
      ) : (
        <AuthRoleStack
          options={stackOptions}
          onSelect={choose}
          disabled={busy !== null}
          busyId={busy}
        />
      )}

      {addMode ? (
        <AuthAccountFooterLink href="/auth/choose-portal">Back to portal chooser</AuthAccountFooterLink>
      ) : null}

      <AuthBackLink onClick={() => void signOut()}>Sign out</AuthBackLink>
    </AuthCard>
  );
}

function GetStartedFallback() {
  return (
    <AuthCard variant="blend">
      <p className="text-center text-sm text-muted">Loading…</p>
    </AuthCard>
  );
}

export default function GetStartedPage() {
  return (
    <Suspense fallback={<GetStartedFallback />}>
      <GetStartedContent />
    </Suspense>
  );
}
