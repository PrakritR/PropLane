"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AuthBrandHeader } from "@/components/auth/auth-mobile-primitives";
import { AuthCard } from "@/components/auth/auth-card";
import { useIsNativeApp } from "@/hooks/use-is-native-app";
import { Button } from "@/components/ui/button";
import { coManagerOpenInvitePath } from "@/lib/co-manager-invite-path";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

type Preview = {
  inviterDisplayName: string;
  propertyLabels: string[];
  expiresAt?: string | null;
};

const TOKEN_STORAGE_KEY = "proplane:co-manager-invite-token";

export function CoManagerInviteClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isNative } = useIsNativeApp();
  const token = useMemo(() => {
    const fromUrl = (searchParams.get("token") ?? "").trim();
    if (fromUrl) return fromUrl;
    if (typeof window === "undefined") return "";
    try {
      return window.sessionStorage.getItem(TOKEN_STORAGE_KEY)?.trim() ?? "";
    } catch {
      return "";
    }
  }, [searchParams]);

  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [signedIn, setSignedIn] = useState(false);
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);

  const invitePath = token ? coManagerOpenInvitePath(token) : "";
  const signInHref = invitePath ? `/auth/sign-in?next=${encodeURIComponent(invitePath)}` : "/auth/sign-in";
  const createHref = invitePath
    ? `/auth/create-account?mode=create&role=manager&tier=free&next=${encodeURIComponent(invitePath)}`
    : "/auth/create-account?mode=create&role=manager";

  useEffect(() => {
    if (!token) return;
    try {
      window.sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
    } catch {
      /* ignore */
    }
  }, [token]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const supabase = createSupabaseBrowserClient();
      const { data } = await supabase.auth.getUser();
      if (!cancelled) setSignedIn(Boolean(data.user));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!token) {
      setLoading(false);
      setPreviewError("This invite link is missing a token.");
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/pro/account-links/redeem?token=${encodeURIComponent(token)}`, {
          cache: "no-store",
        });
        const body = (await res.json()) as Preview & { error?: string };
        if (cancelled) return;
        if (!res.ok) {
          setPreviewError(body.error ?? "This invite link is invalid or has expired.");
          return;
        }
        setPreview({
          inviterDisplayName: body.inviterDisplayName,
          propertyLabels: Array.isArray(body.propertyLabels) ? body.propertyLabels : [],
          expiresAt: body.expiresAt,
        });
      } catch {
        if (!cancelled) setPreviewError("Could not load this invite.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const join = async () => {
    if (!token || joining) return;
    setJoining(true);
    setJoinError(null);
    try {
      const res = await fetch("/api/pro/account-links/redeem", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) {
        setJoinError(body.error ?? "Could not join this team.");
        return;
      }
      try {
        window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
      } catch {
        /* ignore */
      }
      router.replace("/portal/teams/managers");
    } catch {
      setJoinError("Network error.");
    } finally {
      setJoining(false);
    }
  };

  return (
    <AuthCard variant="blend">
      {isNative ? (
        <div className="auth-brand-header-wrap mb-4">
          <AuthBrandHeader homeLink />
        </div>
      ) : null}
      {loading ? (
        <p className="text-center text-sm text-muted">Loading invite…</p>
      ) : previewError || !preview ? (
        <>
          <h1 className="text-xl font-semibold text-foreground">Invite link invalid</h1>
          <p className="mt-2 text-sm text-muted">{previewError ?? "Ask the manager to send a new link."}</p>
          <Button asChild className="mt-6 w-full rounded-full py-2.5 text-[15px] font-semibold">
            <Link href="/auth/sign-in">Sign in</Link>
          </Button>
        </>
      ) : (
        <>
          <h1 className="text-xl font-semibold text-foreground">Join as a co-manager</h1>
          <p className="mt-2 text-sm text-muted">
            <span className="font-semibold text-foreground">{preview.inviterDisplayName}</span> invited you to
            co-manage on PropLane.
          </p>
          {preview.propertyLabels.length > 0 ? (
            <div className="mt-4 rounded-2xl border border-border bg-accent/20 px-4 py-3">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted">Properties</p>
              <ul className="mt-1 space-y-1 text-sm text-foreground">
                {preview.propertyLabels.map((label) => (
                  <li key={label}>{label}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="mt-4 text-sm text-muted">
              Houses will be assigned after you join, or they may already be waiting on this invite.
            </p>
          )}
          {signedIn ? (
            <>
              {joinError ? <p className="mt-4 text-sm text-rose-600">{joinError}</p> : null}
              <Button
                type="button"
                className="mt-6 w-full rounded-full py-2.5 text-[15px] font-semibold"
                loading={joining}
                data-attr="co-manager-invite-join"
                onClick={() => void join()}
              >
                Join team
              </Button>
            </>
          ) : (
            <div className="mt-6 space-y-3">
              <Button asChild className="w-full rounded-full py-2.5 text-[15px] font-semibold" data-attr="co-manager-invite-sign-in">
                <Link href={signInHref}>Sign in to join</Link>
              </Button>
              <Button asChild variant="outline" className="w-full rounded-full py-2.5 text-[15px] font-semibold" data-attr="co-manager-invite-create">
                <Link href={createHref}>Create an account</Link>
              </Button>
            </div>
          )}
        </>
      )}
    </AuthCard>
  );
}
