"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PhoneNumberField } from "@/components/ui/phone-number-field";
import { VendorGoogleSignUpButton } from "@/components/auth/vendor-google-sign-up-button";
import { VendorAppleSignUpButton } from "@/components/auth/vendor-apple-sign-up-button";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { nativeAwarePath } from "@/lib/auth/native-auth-entry";
import { isUnsafeRedirectPath } from "@/lib/auth/normalize-post-auth-path";

export function VendorInviteEmailSignup({ inviteToken, email, initialFullName = "", disabled = false }: {
  inviteToken: string; email: string; initialFullName?: string; disabled?: boolean;
}) {
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
  if (loading) return <p role="status">Loading…</p>;
  if (success) return <div className="space-y-3"><h1 className="text-xl font-semibold">{recovery ? "Account recovery required" : "Vendor account ready"}</h1><Button type="button" onClick={() => window.location.assign(nativeAwarePath(success))}>{recovery ? "Continue recovery" : "Go to portal"}</Button></div>;
  if (sent) return <div className="space-y-3"><h1 className="text-xl font-semibold">Check your email</h1><p role="status">Check your email for a link to continue.</p></div>;
  return <div className="space-y-3">
    <h1 className="text-xl font-semibold">{matches ? "Complete your vendor account" : "Accept your vendor invite"}</h1>
    {!matches ? <><VendorAppleSignUpButton inviteToken={inviteToken} disabled={busy || disabled} /><VendorGoogleSignUpButton inviteToken={inviteToken} disabled={busy || disabled} /><p>Invite email: {email}</p>{verifiedEmail ? <p>Sign in with the email on this invite to continue.</p> : null}</> : <>
      <p>Verified email: {verifiedEmail}</p>
      <label className="block text-sm">Full name<Input autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} disabled={busy || disabled} /></label>
      <label className="block text-sm">Phone<PhoneNumberField value={phone} onChange={setPhone} disabled={busy || disabled} /></label>
    </>}
    <Button type="button" disabled={busy || disabled} onClick={() => void submit()}>{busy ? "Please wait…" : matches ? "Accept invite" : "Continue with email"}</Button>
    {error ? <p role="alert">{error}</p> : null}
  </div>;
}
