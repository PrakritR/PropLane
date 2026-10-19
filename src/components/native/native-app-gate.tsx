"use client";

import { isNativeAppAllowedPath } from "@/lib/auth/native-entry-paths";
import { redirectNativeFromMarketing } from "@/lib/auth/native-welcome-redirect";
import { detectNativePlatformSync, tagHtmlNativePlatform } from "@/lib/native/detect-native";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

/**
 * Native shell: only auth, portals, and in-app flows. Marketing pages redirect away.
 */
export function NativeAppGate({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    let disposed = false;
    void Promise.resolve().then(async () => {
      if (disposed) return;
      const platform = detectNativePlatformSync();
      if (platform) tagHtmlNativePlatform(platform);

      if (!platform) {
        setBlocked(false);
        return;
      }

      if (isNativeAppAllowedPath(pathname)) {
        setBlocked(false);
        return;
      }

      setBlocked(true);
      const [{ createSupabaseBrowserClient }, { safeBrowserGetSession }] = await Promise.all([
        import("@/lib/supabase/browser"),
        import("@/lib/supabase/safe-browser-session"),
      ]);
      if (disposed) return;
      const supabase = createSupabaseBrowserClient();
      void redirectNativeFromMarketing(async () => {
        const { session } = await safeBrowserGetSession(supabase);
        return { session };
      });
    });
    return () => { disposed = true; };
  }, [pathname]);

  if (blocked) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-background">
        <p className="text-sm text-muted">Loading…</p>
      </div>
    );
  }

  return children;
}
