"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PhoneNumberField } from "@/components/ui/phone-number-field";
import { OAuthSocialStack } from "@/components/auth/oauth-social-stack";
import { AuthLegalConsent } from "@/components/auth/auth-mobile-primitives";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { nativeAwarePath } from "@/lib/auth/native-auth-entry";
import { isUnsafeRedirectPath } from "@/lib/auth/normalize-post-auth-path";

type Intent = "generic" | "resident" | "manager" | "vendor" | "manager_paid" | "tour";
type ListingContext = { propertyId?: string; listingRoomId?: string; bundleId?: string; applicationFormId?: string; rentalType?: string };
const endpoint: Record<Intent, string> = { generic: "/api/auth/signup", resident: "/api/auth/resident-register", manager: "/api/auth/manager-register", vendor: "/api/auth/vendor-register", manager_paid: "/api/auth/manager-signup", tour: "/api/auth/tour-resident-register" };
const destination: Record<Intent, string> = { generic: "/auth/continue", resident: "/resident/applications", manager: "/portal", vendor: "/vendor/onboarding", manager_paid: "/portal", tour: "/resident/tour/pending" };
const completionHeading: Record<Intent, string> = {
  generic: "Complete your account", resident: "Complete your resident account", manager: "Complete your property account",
  vendor: "Complete your vendor account", manager_paid: "Complete your property account", tour: "Complete your tour request",
};
const heading: Record<Intent, string> = {
  generic: "Create your account", resident: "Create your resident account", manager: "Create your property account",
  vendor: "Create your vendor account", manager_paid: "Complete your property account", tour: "Continue your tour request",
};

export function EmailFirstSignup({ intent, initialEmail = "", tier, billing, listing, checkoutSessionId, tourInquiryId, social, disabled = false, hideLegalFooter = false }: {
  intent: Intent; initialEmail?: string; tier?: string; billing?: "monthly" | "annual"; listing?: ListingContext; checkoutSessionId?: string; tourInquiryId?: string; social?: ReactNode; disabled?: boolean; hideLegalFooter?: boolean;
}) {
  const [email, setEmail] = useState(initialEmail);
  const [verifiedEmail, setVerifiedEmail] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [completed, setCompleted] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void createSupabaseBrowserClient().auth.getUser().then(({ data }: { data: { user: { email_confirmed_at?: string | null; email?: string | null } | null } }) => {
      if (!alive) return;
      if (intent !== "tour" && data.user?.email_confirmed_at && data.user.email) setVerifiedEmail(data.user.email);
    }).catch(() => undefined).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [intent]);
  async function submit() {
    if (busy || disabled) return;
    setError(null);
    const normalized = (verifiedEmail ?? email).trim().toLowerCase();
    if (!normalized.includes("@")) { setError("Enter a valid email address."); return; }
    if (verifiedEmail && (!name.trim() || phone.replace(/\D/g, "").length < 10)) {
      setError("Enter your name and a valid phone number."); return;
    }
    setBusy(true);
    try {
      const res = await fetch(verifiedEmail ? endpoint[intent] : "/api/auth/email-onboarding/start", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(verifiedEmail
          ? intent === "manager_paid" ? { sessionId: checkoutSessionId, fullName: name.trim(), phone: phone.trim() } : { email: normalized, fullName: name.trim(), phone: phone.trim(), ...(intent === "manager" ? { tier } : {}) }
          : { email: normalized, intent, ...(intent === "manager" ? { tier, billing } : {}), ...(intent === "resident" ? listing : {}), ...(intent === "manager_paid" ? { checkoutSessionId } : {}), ...(intent === "tour" ? { tourInquiryId } : {}) }),
      });
      const body = await res.json().catch(() => ({})) as { error?: string; redirectTo?: string };
      if (!res.ok) { setError(body.error || "Could not continue. Please try again."); return; }
      if (!verifiedEmail) { setSent(true); return; }
      const applyParams = new URLSearchParams();
      if (listing?.propertyId) applyParams.set("propertyId", listing.propertyId);
      if (listing?.listingRoomId) applyParams.set("listingRoomId", listing.listingRoomId);
      if (listing?.bundleId) applyParams.set("bundle", listing.bundleId);
      if (listing?.applicationFormId) applyParams.set("form", listing.applicationFormId);
      if (listing?.rentalType === "short_term") applyParams.set("rentalType", "short_term");
      const path = intent === "resident" && listing?.propertyId
        ? `/resident/applications/apply?${applyParams}`
        : body.redirectTo && !isUnsafeRedirectPath(body.redirectTo) ? body.redirectTo : destination[intent];
      if (intent === "manager" || intent === "manager_paid") setCompleted(path);
      else window.location.assign(nativeAwarePath(path));
    } catch { setError("Could not connect. Please try again."); }
    finally { setBusy(false); }
  }
  if (loading) return <p role="status">Loading…</p>;
  if (completed) return <div className="space-y-3"><h1 className="text-xl font-semibold">Account ready</h1><Button type="button" onClick={() => window.location.assign(nativeAwarePath(completed))}>Go to portal</Button></div>;
  if (sent) return <div className="space-y-3"><h1 className="text-xl font-semibold">Check your email</h1><p role="status">Check your email for a link to continue.</p><Button type="button" variant="ghost" onClick={() => setSent(false)}>Use another email</Button></div>;
  return <div className="space-y-3">
    <h1 className="text-xl font-semibold">{verifiedEmail ? completionHeading[intent] : heading[intent]}</h1>
    {!verifiedEmail ? <>{intent !== "manager_paid" && intent !== "tour" ? social ?? <OAuthSocialStack intent={intent === "generic" ? null : intent} disabled={busy || disabled} /> : null}<label className="block text-sm">Email<Input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} disabled={busy || disabled} /></label></> : <>
      <p>Verified email: {verifiedEmail}</p>
      <><label className="block text-sm">Full name<Input autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} disabled={busy || disabled} /></label><label className="block text-sm">Phone<PhoneNumberField value={phone} onChange={setPhone} disabled={busy || disabled} /></label></>
    </>}
    <Button type="button" disabled={busy || disabled} onClick={() => void submit()}>{busy ? "Please wait…" : verifiedEmail ? "Complete account" : "Continue with email"}</Button>
    {error ? <p role="alert">{error}</p> : null}
    {!hideLegalFooter ? <AuthLegalConsent action="create" /> : null}
  </div>;
}
