"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useConfirm, useAppUi } from "@/components/providers/app-ui-provider";
import posthog from "posthog-js";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { clearPrivateTestWorkspaceListings } from "@/lib/demo-property-pipeline";

type PortalSignOutButtonProps = {
  className?: string;
  onSignedOut?: () => void;
  dataAttr?: string;
  /** Close the account menu before the confirmation takes focus. */
  onRequestConfirm?: () => void;
};

export function PortalSignOutButton({ className, onSignedOut, dataAttr, onRequestConfirm }: PortalSignOutButtonProps) {
  const router = useRouter();
  const confirm = useConfirm();
  const { showToast } = useAppUi();
  const [busy, setBusy] = useState(false);

  const signOut = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // Release this device's push token while the session still proves who owns it.
      try {
        const { releaseCachedPushToken } = await import("@/lib/native/push-client");
        await releaseCachedPushToken();
      } catch {
        /* best-effort: never blocks sign-out */
      }
      const response = await fetch("/api/auth/sign-out", { method: "POST", credentials: "include" });
      if (!response.ok) throw new Error("Could not sign out. Try again.");
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
      showToast("Could not sign out. Try again.");
    }
  };

  const requestSignOut = async () => {
    if (busy) return;
    const answer = confirm({ title: "Sign out", description: "Your session on this device will end.", note: "Your account and saved records stay in PropLane.", confirmLabel: "Sign out", tone: "danger", guard: "tap", dataAttr: "portal-sign-out-confirm" });
    onRequestConfirm?.();
    if (await answer) await signOut();
  };

  return (
    <button
      type="button"
      disabled={busy}
      className={className}
      data-attr={dataAttr}
      onClick={() => requestSignOut()}
    >
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}
