"use client";

import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PhoneNumberField } from "@/components/ui/phone-number-field";
import { AuthPageHeader } from "@/components/auth/auth-mobile-primitives";
import { AuthOAuthLoading } from "@/components/auth/auth-oauth-loading";
import { VendorGoogleSignUpButton } from "@/components/auth/vendor-google-sign-up-button";
import { VendorAppleSignUpButton } from "@/components/auth/vendor-apple-sign-up-button";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { nativeAwarePath } from "@/lib/auth/native-auth-entry";
import { isUnsafeRedirectPath } from "@/lib/auth/normalize-post-auth-path";
import { FIELD_LABEL_CLASS, READONLY_INPUT_CLASS } from "@/lib/ui-styles";

const PRIMARY_BUTTON_CLASS = "btn-cobalt w-full rounded-full py-2.5 text-[15px] font-semibold";

export function VendorInviteEmailSignup({ inviteToken, email, initialFullName = "", disabled = false }: {
  inviteToken: string; email: string; initialFullName?: string; disabled?: boolean;
}) {
  const fieldId = useId();
  const inviteEmailId = `${fieldId}-invite-email`;
  const verifiedEmailId = `${fieldId}-verified-email`;
  const nameId = `${fieldId}-name`;
  const phoneId = `${fieldId}-phone`;
  const [verifiedEmail, setVerifiedEmail] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState(initialFullName);
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [recovery, setRecovery] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const invited = email.trim().toLowerCase();
  const matches = verifiedEmail?.trim().toLowerCase() === invited;
  useEffect(() => {
    let active = true;
    void createSupabaseBrowserClient().auth.getUser().then(({ data }: { data: { user: { email_confirmed_at?: string | null; email?: string | null } | null } }) => {
      if (active && data.user?.email_confirmed_at && data.user.email) setVerifiedEmail(data.user.email);
    }).catch(() => undefined).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  async function submit() {
    if (busy || disabled) return;
    setError(null);
    if (matches && (!name.trim() || phone.replace(/\D/g, "").length < 10)) { setError("Enter your name and a valid phone number."); return; }
    setBusy(true);
    try {
      const res = await fetch(matches ? "/api/auth/vendor-register" : "/api/auth/email-onboarding/start", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(matches
          ? { token: inviteToken, fullName: name.trim(), phone: phone.trim() }
          : { email: invited, intent: "vendor_invite", vendorInviteToken: inviteToken }),
      });
      const body = await res.json().catch(() => ({})) as { error?: string; redirectTo?: string; recoveryRequired?: boolean };
      if (!res.ok) { setError(body.error || "Could not continue. Please try again."); return; }
      if (!matches) { setSent(true); return; }
      if (body.recoveryRequired) {
        if (!body.redirectTo?.startsWith("/auth/recover-account") || isUnsafeRedirectPath(body.redirectTo)) { setError("Account recovery is required. Please sign in to continue."); return; }
        setRecovery(true);
        setSuccess(body.redirectTo);
        return;
      }
      setSuccess(body.redirectTo && !isUnsafeRedirectPath(body.redirectTo) ? body.redirectTo : "/vendor/onboarding");
    } catch { setError("Could not connect. Please try again."); }
    finally { setBusy(false); }
  }
  if (loading) return <AuthOAuthLoading caption="Loading…" />;
  if (success) {
    return (
      <div className="space-y-4">
        <AuthPageHeader eyebrow="Vendor portal" title={recovery ? "Account recovery required" : "Vendor account ready"} />
        <Button type="button" className={PRIMARY_BUTTON_CLASS} onClick={() => window.location.assign(nativeAwarePath(success))}>
          {recovery ? "Continue recovery" : "Go to portal"}
        </Button>
      </div>
    );
  }
  if (sent) {
    return (
      <div className="space-y-4">
        <AuthPageHeader eyebrow="Vendor portal" title="Check your email" />
        <p role="status" className="text-center text-sm text-muted">Check your email for a link to continue.</p>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <AuthPageHeader eyebrow="Vendor portal" title={matches ? "Complete your vendor account" : "Accept your vendor invite"} />
      {!matches ? (
        <div className="space-y-3">
          <VendorAppleSignUpButton inviteToken={inviteToken} disabled={busy || disabled} />
          <VendorGoogleSignUpButton inviteToken={inviteToken} disabled={busy || disabled} />
          <div>
            <label className={FIELD_LABEL_CLASS} htmlFor={inviteEmailId}>Invite email</label>
            <Input id={inviteEmailId} className={READONLY_INPUT_CLASS} value={email} readOnly />
          </div>
          {verifiedEmail ? <p role="status" className="text-center text-sm text-muted">Sign in with the email on this invite to continue.</p> : null}
        </div>
      ) : (
        <div className="space-y-3">
          <div>
            <label className={FIELD_LABEL_CLASS} htmlFor={verifiedEmailId}>Verified email</label>
            <Input id={verifiedEmailId} className={READONLY_INPUT_CLASS} value={verifiedEmail ?? ""} readOnly />
          </div>
          <div>
            <label className={FIELD_LABEL_CLASS} htmlFor={nameId}>Full name</label>
            <Input id={nameId} className="mt-1.5" autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} disabled={busy || disabled} />
          </div>
          <div>
            <label className={FIELD_LABEL_CLASS} htmlFor={phoneId}>Phone</label>
            <PhoneNumberField id={phoneId} className="mt-1.5" value={phone} onChange={setPhone} disabled={busy || disabled} />
          </div>
        </div>
      )}
      <Button type="button" className={PRIMARY_BUTTON_CLASS} disabled={busy || disabled} onClick={() => void submit()}>
        {busy ? "Please wait…" : matches ? "Accept invite" : "Continue with email"}
      </Button>
      {error ? <p role="alert" className="text-center text-sm text-rose-600">{error}</p> : null}
    </div>
  );
}
