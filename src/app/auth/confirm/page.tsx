"use client";

import { AuthCard } from "@/components/auth/auth-card";
import { PASSWORD_RESET_NEXT_PATH } from "@/lib/auth/password-reset-url";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import type { EmailOtpType } from "@supabase/supabase-js";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

const VALID_TYPES: EmailOtpType[] = ["signup", "invite", "magiclink", "recovery", "email_change", "email"];

function parseEmailOtpType(raw: string | null): EmailOtpType | null {
  return VALID_TYPES.includes(raw as EmailOtpType) ? (raw as EmailOtpType) : null;
}

/**
 * Where a verified token lands. Derived from `type` alone — deliberately NOT from a
 * `next` query param, so an emailed confirm link can never be rewritten into a
 * redirect somewhere else.
 */
function destinationForType(type: EmailOtpType): string {
  if (type === "recovery") return PASSWORD_RESET_NEXT_PATH;
  if (type === "invite") return "/auth/test-workspace-setup";
  return "/auth/continue";
}

/**
 * Exchanges an emailed confirmation token for a session via `verifyOtp` — this app's
 * browser client is PKCE-only, so it can't pick up Supabase's hosted verify redirect
 * (which appends session tokens as an implicit-flow URL hash). Works regardless of flow type.
 *
 * A `token_hash` is also NOT bound to the browser that requested it, unlike a PKCE
 * `code`, so a link mailed to a phone opens fine on a laptop. That is why password
 * recovery routes here rather than through `/auth/callback` (see `password-reset-url.ts`).
 */
function ConfirmContent() {
  const searchParams = useSearchParams();
  const [failedType, setFailedType] = useState<EmailOtpType | "unknown" | null>(null);
  const [completionUnavailable, setCompletionUnavailable] = useState(false);
  const [restartRequired, setRestartRequired] = useState(false);

  useEffect(() => {
    const tokenHash = searchParams.get("token_hash");
    const type = parseEmailOtpType(searchParams.get("type"));
    if (!tokenHash || !type) {
      setFailedType(type ?? "unknown");
      return;
    }
    let cancelled = false;
    void (async () => {
      const supabase = createSupabaseBrowserClient();
      let error: { status?: number; code?: string; message: string } | null;
      try {
        ({ error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type }));
      } catch {
        if (!cancelled) setCompletionUnavailable(true);
        return;
      }
      if (cancelled) return;
      if (error && ((error.status ?? 0) >= 500 || error.code === "unexpected_failure")) {
        setCompletionUnavailable(true);
        return;
      }
      if (type === "magiclink" || type === "signup") {
        const finish = () => fetch("/api/auth/email-onboarding/finish", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tokenHash }) });
        let completed: Response;
        try {
          completed = await finish();
          // `finish` reads the session server-side, so a 401 means the browser client's cookie
          // write had not propagated to this fetch yet — not that the link failed. Flush and ask
          // once more before deciding there was no onboarding claim.
          if (completed.status === 401) {
            await supabase.auth.refreshSession().catch(() => undefined);
            completed = await finish();
          }
        } catch {
          if (!cancelled) setCompletionUnavailable(true);
          return;
        }
        if (cancelled) return;
        if (completed.ok) { try { sessionStorage.removeItem("proplane_tour_invite"); } catch { /* unavailable */ } }
        if (!completed.ok && completed.status === 403 && !error) { setRestartRequired(true); return; }
        if (!completed.ok && completed.status >= 500) { setCompletionUnavailable(true); return; }
        // Ordinary magic links have no onboarding claim and retain their existing destination.
        // 409 (claim already spent) and a persistent 401 (no server-visible session to claim with)
        // both mean "nothing to claim": `verifyOtp` SUCCEEDED, so the user is signed in and must
        // never be shown "link failed" and told to request another one.
        if (!completed.ok && (error || (completed.status !== 409 && completed.status !== 401))) { setFailedType(type); return; }
      } else if (error) {
        setFailedType(type);
        return;
      }
      window.location.replace(destinationForType(type));
    })();
    return () => {
      cancelled = true;
    };
  }, [searchParams]);

  if (restartRequired) {
    return <AuthCard><h1>Request a new verification link</h1><p>Return to the original application or invitation and request another verification email. Your saved application stays in its original context.</p><Link href="/auth/create-account">Open account setup</Link></AuthCard>;
  }

  if (completionUnavailable) {
    return <AuthCard><h1>Could not complete verification</h1><p>Check your connection and open this link again, or request another link.</p><Link href={searchParams.get("type") === "recovery" ? "/auth/forgot-password" : "/auth/create-account"}>Request another link</Link></AuthCard>;
  }

  if (failedType) {
    const isRecovery = failedType === "recovery";
    return (
      <AuthCard>
        <h1 className="text-center text-[22px] font-bold tracking-tight text-foreground">
          {isRecovery ? "This reset link no longer works" : "Link invalid"}
        </h1>
        <p className="mt-2 text-center text-sm text-muted">
          {isRecovery
            ? "Password reset links expire after about an hour and can only be used once. Request a new one — it will work on any device."
            : "This confirmation link is invalid or has expired."}
        </p>
        <Link
          className="mt-8 flex w-full justify-center text-sm font-semibold text-primary hover:opacity-90"
          href={isRecovery ? "/auth/forgot-password" : "/auth/sign-in"}
        >
          {isRecovery ? "Request a new reset link →" : "← Back to sign in"}
        </Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard>
      <p className="text-center text-sm text-muted">Confirming your account…</p>
    </AuthCard>
  );
}

export default function ConfirmPage() {
  return (
    <Suspense
      fallback={
        <AuthCard>
          <p className="text-center text-sm text-muted">Confirming your account…</p>
        </AuthCard>
      }
    >
      <ConfirmContent />
    </Suspense>
  );
}
