"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AuthCard } from "@/components/auth/auth-card";
import { AuthPageHeader } from "@/components/auth/auth-mobile-primitives";
import { Button } from "@/components/ui/button";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { inviteLinkUnusableMessage, type InviteLinkUnusableReason } from "@/lib/invite-links/invite-link-model";

type Preview = {
  kind: "manager" | "vendor";
  ownerName: string;
  propertyLabels: string[];
  unusableReason: InviteLinkUnusableReason | null;
};

/**
 * The screen an invite link opens.
 *
 * Redeeming is a click, never automatic on load: it links the opener's account
 * to someone else's portfolio, and a page that did it on arrival would mean a
 * URL in a group chat could quietly change your account. Signing in first is
 * required for the same reason — there has to be an account for the grant to
 * land on, and it has to be the one the person meant.
 */
export default function InviteLinkClient({ token }: { token: string }) {
  const router = useRouter();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const supabase = createSupabaseBrowserClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!cancelled) setSignedIn(Boolean(session));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/pro/invite-links/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        if (cancelled) return;
        if (!res.ok) {
          setNotFound(true);
          return;
        }
        setPreview((await res.json()) as Preview);
      } catch {
        if (!cancelled) setNotFound(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const accept = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/pro/invite-links/redeem", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const body = (await res.json().catch(() => ({}))) as { inviteId?: string; error?: string };
      if (!res.ok || !body.inviteId) {
        setError(body.error ?? "Could not accept this invite.");
        return;
      }
      // Hand off to the existing accept screen, which is what actually links the
      // accounts — one implementation of "become a co-manager", not a second.
      router.replace(`/portal/teams/managers/${encodeURIComponent(body.inviteId)}`);
    } catch {
      setError("Could not accept this invite.");
    } finally {
      setBusy(false);
    }
  }, [router, token]);

  if (notFound) {
    return (
      <AuthCard variant="blend">
        <AuthPageHeader showLogo title="Invite not found" subtitle="This link is not valid. Ask for a new one." />
      </AuthCard>
    );
  }

  if (!preview) {
    return (
      <AuthCard variant="blend">
        <p className="text-center text-sm text-muted">Loading…</p>
      </AuthCard>
    );
  }

  if (preview.unusableReason) {
    return (
      <AuthCard variant="blend">
        <AuthPageHeader
          showLogo
          title="This invite is no longer active"
          subtitle={inviteLinkUnusableMessage(preview.unusableReason)}
        />
      </AuthCard>
    );
  }

  const isVendor = preview.kind === "vendor";

  return (
    <AuthCard variant="blend">
      <AuthPageHeader
        showLogo
        title={`${preview.ownerName} invited you`}
        subtitle={
          isVendor
            ? "Join their vendor directory on PropLane."
            : "Co-manage the properties below with them on PropLane."
        }
      />

      {preview.propertyLabels.length > 0 ? (
        <div className="mt-5 rounded-2xl border border-border bg-accent/20 p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">
            {preview.propertyLabels.length === 1 ? "Property" : "Properties"}
          </p>
          <ul className="mt-2 space-y-1 text-sm">
            {preview.propertyLabels.map((label, i) => (
              <li key={`${label}-${i}`}>{label}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {error ? <p className="mt-4 text-center text-sm text-rose-600">{error}</p> : null}

      <div className="mt-6">
        {signedIn === false ? (
          <Button
            type="button"
            className="w-full rounded-full py-2.5 text-[15px] font-semibold"
            onClick={() =>
              router.push(`/auth/sign-in?next=${encodeURIComponent(`/invite/${token}`)}`)
            }
          >
            Sign in to accept
          </Button>
        ) : (
          <Button
            type="button"
            className="w-full rounded-full py-2.5 text-[15px] font-semibold"
            data-attr="invite-link-accept"
            loading={busy}
            onClick={() => accept()}
          >
            Continue
          </Button>
        )}
      </div>

      <p className="mt-4 text-center text-xs text-muted">
        You will see exactly what you are being given access to before anything is linked.
      </p>
    </AuthCard>
  );
}
