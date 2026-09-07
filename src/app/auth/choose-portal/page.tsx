"use client";

import { AuthCard } from "@/components/auth/auth-card";
import { AuthBackLink, AuthPageHeader, AuthRoleStack, AuthAccountFooterLink } from "@/components/auth/auth-mobile-primitives";
import { useAuthWelcomeChrome } from "@/components/auth/use-auth-welcome-chrome";
import { type AuthRole } from "@/components/auth/portal-switcher";
import type { AuthRoleIconName } from "@/components/auth/auth-role-icons";
import { getStartedAddPortalPath } from "@/lib/auth/get-started-path";
import { normalizePostAuthPath } from "@/lib/auth/normalize-post-auth-path";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { useRouter, useSearchParams } from "next/navigation";
import posthog from "posthog-js";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

const ROLE_META: Record<
  AuthRole,
  { label: string; hint: string; icon: AuthRoleIconName; tone: "blue" | "steel" }
> = {
  admin: {
    label: "Admin",
    hint: "Platform administration",
    icon: "admin",
    tone: "blue",
  },
  manager: {
    label: "Property",
    hint: "Manage properties & tenants",
    icon: "manager",
    tone: "blue",
  },
  resident: {
    label: "Resident",
    hint: "Rent, pay & apply",
    icon: "resident",
    tone: "blue",
  },
  vendor: {
    label: "Vendor",
    hint: "Services & scheduling",
    icon: "vendor",
    tone: "blue",
  },
};

function choosePortalSignInNext(nextRaw: string): string {
  if (!nextRaw.trim()) return "/auth/choose-portal";
  const params = new URLSearchParams();
  params.set("next", nextRaw);
  return `/auth/choose-portal?${params.toString()}`;
}

function ChoosePortalForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  useAuthWelcomeChrome(true);
  const nextRaw = searchParams.get("next") ?? "";

  const [roles, setRoles] = useState<AuthRole[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const autoChooseAttemptedRef = useRef(false);

  const loadRoles = useCallback(async (): Promise<
    | { kind: "ok"; roles: AuthRole[] }
    | { kind: "unauthorized" }
    | { kind: "error"; message: string }
  > => {
    const res = await fetch("/api/auth/portal-roles", { credentials: "include" });
    const body = (await res.json().catch(() => ({}))) as { roles?: AuthRole[]; error?: string };
    if (!res.ok) {
      if (res.status === 401) {
        router.replace(
          `/auth/sign-in?next=${encodeURIComponent(choosePortalSignInNext(nextRaw))}`,
        );
        return { kind: "unauthorized" };
      }
      return {
        kind: "error",
        message: body.error ?? "Could not load your account.",
      };
    }
    return {
      kind: "ok",
      roles: (body.roles ?? []).filter((role): role is AuthRole => role in ROLE_META),
    };
  }, [nextRaw, router]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoadError(null);
      setRoles(null);
      try {
        const result = await loadRoles();
        if (cancelled || result.kind === "unauthorized") return;
        if (result.kind === "error") {
          setLoadError(result.message);
          setRoles([]);
          return;
        }
        setRoles(result.roles);
      } catch {
        if (!cancelled) {
          setLoadError("Could not load your account.");
          setRoles([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadRoles, reloadToken]);

  const stackOptions = useMemo(
    () =>
      (roles ?? []).map((role) => ({
        id: role,
        label: ROLE_META[role].label,
        hint: ROLE_META[role].hint,
        icon: ROLE_META[role].icon,
        tone: ROLE_META[role].tone,
      })),
    [roles],
  );

  const choose = useCallback(
    async (role: AuthRole) => {
      setBusy(role);
      setLoadError(null);
      try {
        const res = await fetch("/api/auth/set-active-portal", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ role }),
        });
        const body = (await res.json()) as { error?: string };
        if (!res.ok) {
          setLoadError(body.error ?? "Could not continue.");
          setBusy(null);
          return;
        }
        const dest = normalizePostAuthPath(nextRaw, role);
        // Hard navigation — router.push + refresh left multi-role users stuck on
        // "Opening…" while Turbopack compiled the portal shell (Next "Rendering…").
        window.location.assign(dest);
      } catch {
        setLoadError("Network error.");
        setBusy(null);
      }
    },
    [nextRaw],
  );

  useEffect(() => {
    if (roles?.length !== 1 || busy !== null || autoChooseAttemptedRef.current) return;
    autoChooseAttemptedRef.current = true;
    void choose(roles[0]!);
  }, [roles, busy, choose]);

  const signOut = async () => {
    const supabase = createSupabaseBrowserClient();
    await supabase.auth.signOut();
    try {
      posthog.reset();
    } catch {
      /* ignore — analytics reset is best-effort */
    }
    router.push("/auth/sign-in");
    router.refresh();
  };

  const loadingRoles = roles === null;

  return (
    <AuthCard variant="blend">
      <AuthPageHeader
        showLogo
        title="Choose a portal"
        subtitle="Same email works for every portal. Switch anytime from Settings."
        accent={false}
      />

      {loadError ? <p className="mt-4 text-center text-sm text-rose-600">{loadError}</p> : null}

      {loadingRoles ? (
        <p className="auth-role-stack text-center text-sm text-muted">Loading…</p>
      ) : roles.length === 0 ? (
        loadError ? (
          <div className="auth-role-stack text-center">
            <button
              type="button"
              className="text-sm font-semibold text-primary hover:opacity-90"
              onClick={() => setReloadToken((token) => token + 1)}
              data-attr="choose-portal-retry"
            >
              Try again
            </button>
          </div>
        ) : (
          <p className="auth-role-stack text-center text-sm text-muted">No portal roles found.</p>
        )
      ) : (
        <AuthRoleStack
          variant="blend"
          options={stackOptions}
          onSelect={(id) => void choose(id as AuthRole)}
          disabled={busy !== null}
          busyId={busy}
        />
      )}

      <AuthAccountFooterLink href={getStartedAddPortalPath()}>
        Add another portal type
      </AuthAccountFooterLink>

      <AuthBackLink onClick={() => void signOut()}>Sign out</AuthBackLink>
    </AuthCard>
  );
}

function ChoosePortalFallback() {
  return (
    <AuthCard variant="blend">
      <p className="text-center text-sm text-muted">Loading…</p>
    </AuthCard>
  );
}

export default function ChoosePortalPage() {
  return (
    <Suspense fallback={<ChoosePortalFallback />}>
      <ChoosePortalForm />
    </Suspense>
  );
}
