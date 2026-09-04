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

function ChoosePortalForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  useAuthWelcomeChrome(true);
  const nextRaw = searchParams.get("next") ?? "";

  const [roles, setRoles] = useState<AuthRole[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const autoChooseAttemptedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/auth/portal-roles", { credentials: "include" });
        const body = (await res.json()) as { roles?: AuthRole[]; error?: string };
        if (!res.ok) {
          if (!cancelled) setError(body.error ?? "Could not load your account.");
          return;
        }
        if (!cancelled) {
          setRoles((body.roles ?? []).filter((role): role is AuthRole => role in ROLE_META));
        }
      } catch {
        if (!cancelled) setError("Could not load your account.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
      setError(null);
      try {
        const res = await fetch("/api/auth/set-active-portal", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ role }),
        });
        const body = (await res.json()) as { error?: string };
        if (!res.ok) {
          setError(body.error ?? "Could not continue.");
          setBusy(null);
          return;
        }
        const dest = normalizePostAuthPath(nextRaw, role);
        // Hard navigation — router.push + refresh left multi-role users stuck on
        // "Opening…" while Turbopack compiled the portal shell (Next "Rendering…").
        window.location.assign(dest);
      } catch {
        setError("Network error.");
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

  return (
    <AuthCard variant="blend">
      <AuthPageHeader
        showLogo
        title="Choose a portal"
        subtitle="Same email works for every portal. Switch anytime from Settings."
        accent={false}
      />

      {error ? <p className="mt-4 text-center text-sm text-rose-600">{error}</p> : null}

      {roles === null ? (
        <p className="auth-role-stack text-center text-sm text-muted">Loading…</p>
      ) : roles.length === 0 ? (
        <p className="auth-role-stack text-center text-sm text-muted">No portal roles found.</p>
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
