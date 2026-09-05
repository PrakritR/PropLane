"use client";

import { useEffect, useState } from "react";
import type { AuthRole } from "@/components/auth/portal-switcher";
import { AUTH_CALL_TIMEOUT_MS, withAuthTimeout } from "@/lib/auth/with-timeout";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { safeBrowserGetSession } from "@/lib/supabase/safe-browser-session";

export type SignedInPortalRoles = {
  /** Session email, or null when signed out. */
  email: string | null;
  /** Portals this login can already enter (from `/api/auth/portal-roles`). */
  roles: AuthRole[];
  loading: boolean;
};

/**
 * Shared probe for the create-account tabs: is someone signed in, and which
 * portals do they already hold? Each signup form uses this to decide between the
 * signup form (signed out, or adding a role they lack) and the "already have
 * this access — go to your portal" panel (a role they already hold), so the
 * three tabs branch identically instead of each hand-rolling its own session
 * check. Mirrors the fetch `AuthSignedInRoleBanner` already does.
 */
export function useSignedInPortalRoles(): SignedInPortalRoles {
  const [email, setEmail] = useState<string | null>(null);
  const [roles, setRoles] = useState<AuthRole[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const supabase = createSupabaseBrowserClient();
        const { session } = await withAuthTimeout(
          safeBrowserGetSession(supabase),
          AUTH_CALL_TIMEOUT_MS,
          "Session check timed out.",
        );
        const sessionEmail = session?.user?.email ?? null;
        if (!cancelled) setEmail(sessionEmail);
        if (!sessionEmail) {
          if (!cancelled) setRoles([]);
          return;
        }
        const res = await withAuthTimeout(
          fetch("/api/auth/portal-roles", { credentials: "include" }),
          AUTH_CALL_TIMEOUT_MS,
          "Session check timed out.",
        );
        const body = (await res.json().catch(() => ({}))) as { roles?: AuthRole[] };
        if (!cancelled) setRoles(res.ok && Array.isArray(body.roles) ? body.roles : []);
      } catch {
        if (!cancelled) setRoles([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { email, roles, loading };
}
