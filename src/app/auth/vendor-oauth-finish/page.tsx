"use client";

import { AuthCard } from "@/components/auth/auth-card";
import { GoogleSignedInBanner } from "@/components/auth/google-signed-in-banner";
import {
  clearVendorSignupInviteToken,
  clearVendorSignupNext,
  readVendorSignupInviteToken,
  readVendorSignupNext,
} from "@/lib/auth/vendor-oauth-storage";
import { queuePendingNotice, VENDOR_PORTAL_PATH } from "@/lib/pending-notice";
import { waitForAuthUser } from "@/lib/auth/wait-for-auth-user";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import Link from "next/link";
import { Suspense, useEffect, useRef, useState } from "react";

function VendorOauthFinishContent() {
  const [errorText, setErrorText] = useState<string | null>(null);
  const [googleEmail, setGoogleEmail] = useState<string | null>(null);
  const [googleName, setGoogleName] = useState<string | null>(null);
  const didRunRef = useRef(false);

  useEffect(() => {
    if (didRunRef.current) return;
    didRunRef.current = true;

    void (async () => {
      try {
        const supabase = createSupabaseBrowserClient();
        const user = await waitForAuthUser(supabase);
        if (!user) {
          setErrorText("Google sign-in did not complete. Try again.");
          return;
        }
        setGoogleEmail(user.email ?? null);
        setGoogleName(
          typeof user.user_metadata?.full_name === "string"
            ? user.user_metadata.full_name
            : typeof user.user_metadata?.name === "string"
              ? user.user_metadata.name
              : null,
        );

        const storedToken = readVendorSignupInviteToken();
        const res = await fetch("/api/auth/register-vendor-oauth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify(storedToken ? { token: storedToken } : {}),
        });
        const body = (await res.json()) as {
          error?: string; recoveryRequired?: boolean; redirectTo?: string;
          unlinkedReason?: string | null;
          unlinkedNotice?: string | null;
        };
        if (!res.ok) {
          setErrorText(body.error ?? "Could not finish vendor signup.");
          return;
        }

        if (body.recoveryRequired && body.redirectTo?.startsWith("/auth/recover-account")) {
          window.location.replace(body.redirectTo);
          return;
        }

        clearVendorSignupInviteToken();
        const next = readVendorSignupNext();
        clearVendorSignupNext();
        if (body.unlinkedReason && body.unlinkedNotice) {
          queuePendingNotice({ message: body.unlinkedNotice, pathPrefix: VENDOR_PORTAL_PATH });
        }
        window.location.replace(next ?? "/vendor/dashboard");
      } catch (e) {
        const message = e instanceof Error ? e.message : "Could not finish vendor signup.";
        setErrorText(message);
      }
    })();
  }, []);

  if (errorText) {
    return (
      <AuthCard>
        <p className="text-center text-sm text-rose-600">{errorText}</p>
        <div className="mt-6 flex justify-center">
          <Link
            className="text-sm font-semibold text-primary hover:underline"
            href="/auth/create-account?role=vendor&mode=create"
          >
            Back to create account
          </Link>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard>
      {googleEmail ? (
        <GoogleSignedInBanner
          email={googleEmail}
          fullName={googleName}
          subtitle="Setting up your vendor account…"
        />
      ) : (
        <p className="text-center text-sm text-muted">Setting up your vendor account…</p>
      )}
    </AuthCard>
  );
}

export default function VendorOauthFinishPage() {
  return (
    <Suspense
      fallback={
        <AuthCard>
          <p className="text-center text-sm text-muted">Loading…</p>
        </AuthCard>
      }
    >
      <VendorOauthFinishContent />
    </Suspense>
  );
}
