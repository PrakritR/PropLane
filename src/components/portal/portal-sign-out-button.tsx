"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import posthog from "posthog-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { clearPrivateTestWorkspaceListings } from "@/lib/demo-property-pipeline";

type PortalSignOutButtonProps = {
  className?: string;
  onSignedOut?: () => void;
  dataAttr?: string;
};

export function PortalSignOutButton({ className, onSignedOut, dataAttr }: PortalSignOutButtonProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const signOut = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await fetch("/api/auth/sign-out", { method: "POST", credentials: "include" });
      try {
        posthog.reset();
      } catch {
        /* ignore — analytics reset is best-effort */
      }
      try {
        const supabase = createSupabaseBrowserClient();
        await supabase.auth.signOut({ scope: "local" });
      } catch {
        /* ignore — server route already cleared session */
      }
      clearPrivateTestWorkspaceListings();
      onSignedOut?.();
      router.push("/auth/sign-in");
      router.refresh();
    } catch {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      disabled={busy}
      className={className}
      data-attr={dataAttr}
      onClick={() => void signOut()}
    >
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}
