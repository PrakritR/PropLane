"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { usePortalSession } from "@/hooks/use-portal-session";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { clearStaleBrowserAuth } from "@/lib/supabase/safe-browser-session";

/**
 * The portal shell is server-rendered from HTTP cookies, but panels read the
 * browser Supabase session. When refresh fails (429, rotated token, background
 * resume) the shell still looks signed in while every panel sees `userId: null`.
 * Send the visitor back through sign-in with the current path preserved.
 */
export function PortalClientSessionGuard() {
  const { userId, ready } = usePortalSession();
  const pathname = usePathname();
  const router = useRouter();
  const redirectingRef = useRef(false);

  useEffect(() => {
    if (!ready || userId || isDemoModeActive() || redirectingRef.current) return;

    redirectingRef.current = true;
    const next =
      pathname && pathname.startsWith("/") ? `${pathname}${window.location.search}` : "/portal/dashboard";

    void (async () => {
      try {
        const supabase = createSupabaseBrowserClient();
        await clearStaleBrowserAuth(supabase);
      } catch {
        /* redirect even when local cleanup fails */
      }
      router.replace(`/auth/sign-in?next=${encodeURIComponent(next)}`);
    })();
  }, [pathname, ready, router, userId]);

  return null;
}
