"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AuthCard } from "@/components/auth/auth-card";
import { AuthPageHeader } from "@/components/auth/auth-mobile-primitives";
import { Button } from "@/components/ui/button";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { inviteLinkUnusableMessage, type InviteLinkUnusableReason } from "@/lib/invite-links/invite-link-model";

type Preview = {
  kind: "manager" | "vendor" | "resident";
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
  const [claimed, setClaimed] = useState(false);

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
      const body = (await res.json().catch(() => ({}))) as {
        kind?: string;
        inviteId?: string;
        claimId?: string;
        error?: string;
      };
      if (!res.ok) {
        setError(body.error ?? "Could not accept this invite.");
        return;
      }
      // A RESIDENT link grants nothing on redeem — it files a request the
      // manager approves — so there is no accept screen to hand off to. Saying
      // so plainly is the honest end of this flow; anything that looked like
      // "you're in" would be a lie until a manager acts.
      if (body.kind === "resident") {
        if (!body.claimId) {
          setError(body.error ?? "Could not send your request.");
          return;
        }
        setClaimed(true);
        return;
      }
      if (!body.inviteId) {
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
  const isResident = preview.kind === "resident";

  // A resident's claim is filed, not granted. Ending on "we sent your request"
  // is the truthful screen: nothing about their account has changed yet.
  if (claimed) {
    return (
      <AuthCard variant="blend">
        <AuthPageHeader
          showLogo
          title="Request sent"
          subtitle={`${preview.ownerName} will confirm you live here and set up your resident portal. You will get an email when they do.`}
        />
        <div className="mt-6">
          <Button
            type="button"
            className="w-full rounded-full py-2.5 text-[15px] font-semibold"
            onClick={() => router.push("/")}
          >
            Done
          </Button>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard variant="blend">
      <AuthPageHeader
        showLogo
        title={isResident ? `${preview.ownerName} invited you to PropLane` : `${preview.ownerName} invited you`}
        subtitle={
          isResident
            ? "Already living in one of the homes below? Confirm it and they will set up your resident portal."
            : isVendor
              ? "Join their vendor directory on PropLane."
              : "Co-manage the properties below with them on PropLane."
        }
      />

      {preview.propertyLabels.length > 0 ? (
        <div className="mt-5 rounded-2xl border border-border bg-accent/20 p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">
            {isResident
              ? preview.propertyLabels.length === 1
                ? "Home"
                : "Homes"
              : preview.propertyLabels.length === 1
                ? "Property"
                : "Properties"}
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
            {isResident ? "Sign in or create an account" : "Sign in to accept"}
          </Button>
        ) : (
          <Button
            type="button"
            className="w-full rounded-full py-2.5 text-[15px] font-semibold"
            data-attr="invite-link-accept"
            loading={busy}
            onClick={() => accept()}
          >
            {isResident ? "This is my home" : "Continue"}
          </Button>
        )}
      </div>

      <p className="mt-4 text-center text-xs text-muted">
        {isResident
          ? "This sends a request to your property manager. Nothing on your account changes until they confirm it."
          : "You will see exactly what you are being given access to before anything is linked."}
      </p>
    </AuthCard>
  );
}
