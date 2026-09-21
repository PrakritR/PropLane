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
      const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
      if (cancelled) return;
      if (error) {
        setFailedType(type);
        return;
      }
      window.location.replace(destinationForType(type));
    })();
    return () => {
      cancelled = true;
    };
  }, [searchParams]);

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
