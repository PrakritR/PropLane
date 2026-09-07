"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AuthBrandHeader } from "@/components/auth/auth-mobile-primitives";
import { AuthCard } from "@/components/auth/auth-card";
import { VendorSignupForm } from "@/components/auth/vendor-signup-form";
import { useIsNativeApp } from "@/hooks/use-is-native-app";
import { Button } from "@/components/ui/button";

/** Vendor account creation — invite link (?token=…) or redirect to unified create-account. */
export default function VendorRegisterClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isNative } = useIsNativeApp();
  const inviteToken = useMemo(() => (searchParams.get("token") ?? "").trim(), [searchParams]);

  const [checkingInvite, setCheckingInvite] = useState(Boolean(inviteToken));
  const [inviteInvalid, setInviteInvalid] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteFullName, setInviteFullName] = useState("");

  useEffect(() => {
    if (inviteToken) return;
    router.replace("/auth/create-account?mode=create&role=vendor");
  }, [inviteToken, router]);

  useEffect(() => {
    if (!inviteToken) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/auth/vendor-register?token=${encodeURIComponent(inviteToken)}`, {
          cache: "no-store",
        });
        const body = (await res.json()) as { email?: string; name?: string; error?: string };
        if (cancelled) return;
        if (!res.ok) {
          setInviteInvalid(true);
          return;
        }
        setInviteEmail(body.email ?? "");
        setInviteFullName(body.name ?? "");
      } catch {
        if (!cancelled) setInviteInvalid(true);
      } finally {
        if (!cancelled) setCheckingInvite(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [inviteToken]);

  if (!inviteToken) {
    return (
      <AuthCard>
        <p className="text-center text-sm text-muted">Loading…</p>
      </AuthCard>
    );
  }

  if (checkingInvite) {
    return (
      <AuthCard>
        <p className="text-center text-sm text-muted">Loading your invite…</p>
      </AuthCard>
    );
  }

  if (inviteInvalid) {
    return (
      <AuthCard>
        <h1 className="text-xl font-semibold text-foreground">Invite link invalid</h1>
        <p className="mt-2 text-sm text-muted">
          This vendor invite link is invalid or has expired. Ask your property manager to resend it, or sign up
          without an invite below.
        </p>
        <Button
          type="button"
          className="mt-6 w-full rounded-full py-2.5 text-[15px] font-semibold"
          onClick={() => router.push("/auth/create-account?mode=create&role=vendor")}
        >
          Create your account
        </Button>
      </AuthCard>
    );
  }

  return (
    <AuthCard variant="blend" wide>
      {isNative ? (
        <div className="auth-brand-header-wrap mb-4">
          <AuthBrandHeader homeLink />
        </div>
      ) : null}
      <VendorSignupForm
        variant="compact"
        hideLegalFooter
        inviteToken={inviteToken}
        initialEmail={inviteEmail}
        initialFullName={inviteFullName}
      />
    </AuthCard>
  );
}
