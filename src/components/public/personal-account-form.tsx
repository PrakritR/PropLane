"use client";

import Link from "next/link";
import { useState } from "react";
import { DoorButton, DoorShell } from "@/components/public/phone-bound-link-ui";
import { persistOAuthSignInContext } from "@/lib/auth/oauth-next-cookie";
import { resolveOAuthCallbackRedirectUrl } from "@/lib/auth/native-oauth-callback";
import { resolveOAuthBrowserOrigin } from "@/lib/auth/password-reset-url";
import { PERSONAL_PASSWORD_MIN, type PersonalAccountPrefill } from "@/lib/personal-link/model";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

/**
 * The personal account link's page (`/l/<token>`, purpose `account`): name, email and a password, or Continue with
 * Google. The link only ever reaches a phone that already proved itself, so the phone is already linked; the email
 * stays a claim until its own emailed link is opened. When it is done the person lands where the conversation is
 * (Communication) and the home they asked about is one tap away.
 */
type Done = { nextPath: string; propertyPath: string | null; signedIn: boolean };

export function PersonalAccountForm({ token, prefill }: { token: string; prefill: PersonalAccountPrefill }) {
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [done, setDone] = useState<Done | null>(null);

  const submit = async (provider?: "google"): Promise<Done | null> => {
    setError("");
    setNeedsSignIn(false);
    try {
      const res = await fetch(`/api/l/${encodeURIComponent(token)}/account`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ fullName, email, ...(provider ? { provider } : { password }) }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; nextPath?: string; propertyPath?: string | null; signedIn?: boolean };
      if (res.ok && typeof data.nextPath === "string") {
        return { nextPath: data.nextPath, propertyPath: data.propertyPath ?? null, signedIn: data.signedIn === true };
      }
      if (res.status === 409) setNeedsSignIn(true);
      setError(data.error ?? "We could not finish that. Try again.");
    } catch {
      setError("Could not reach PropLane. Check your connection.");
    }
    return null;
  };

  const create = async () => {
    const result = await submit();
    if (!result) return;
    if (!result.signedIn) window.location.assign(result.nextPath);
    else setDone(result);
  };

  // The account is made first (phone-proven, session opened), then the Google identity is linked to THAT account: the
  // phone-proven account is never replaced by a second one.
  const withGoogle = async () => {
    const result = await submit("google");
    if (!result) return;
    if (!result.signedIn) {
      window.location.assign(result.nextPath);
      return;
    }
    try {
      persistOAuthSignInContext({ nextPath: result.nextPath });
      const { error: linkError } = await createSupabaseBrowserClient().auth.linkIdentity({
        provider: "google",
        options: { redirectTo: resolveOAuthCallbackRedirectUrl(resolveOAuthBrowserOrigin()) },
      });
      if (!linkError) return;
    } catch {
      /* fall through: the account exists and is signed in */
    }
    setDone(result);
    setError("We could not connect Google just now. Your account is ready.");
  };

  if (done) {
    return (
      <DoorShell title="Your account is ready" dataAttr="personal-account-done">
        <Link href={done.nextPath} className="ps-btn ps-btn-blue" data-attr="personal-account-open-conversation">
          Open your conversation
        </Link>
        {done.propertyPath ? (
          <Link href={done.propertyPath} className="ps-btn ps-btn-line" data-attr="personal-account-open-property">
            {prefill.houseLabel ? `Apply for ${prefill.houseLabel}` : "Apply for this home"}
          </Link>
        ) : null}
        {error ? <p className="ps-error" role="status">{error}</p> : null}
      </DoorShell>
    );
  }

  const title = prefill.houseLabel ? `Save your chat about ${prefill.houseLabel}` : "Create your account";
  const nameOk = fullName.trim().length >= 2;

  return (
    <DoorShell title={title} dataAttr="personal-account">
      <label className="ps-field">
        <span className="ps-label">Full name</span>
        <input className="ps-input" value={fullName} onChange={(e) => setFullName(e.target.value)} autoComplete="name" data-attr="personal-account-name" />
      </label>
      <label className="ps-field">
        <span className="ps-label">Email</span>
        <input className="ps-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" data-attr="personal-account-email" />
      </label>
      <label className="ps-field">
        <span className="ps-label">Password</span>
        <input className="ps-input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" data-attr="personal-account-password" />
      </label>
      <label className="ps-field">
        <span className="ps-label">Phone</span>
        <input className="ps-input" value={prefill.maskedPhone} readOnly aria-readonly="true" data-attr="personal-account-phone" />
      </label>
      <DoorButton dataAttr="personal-account-finish" disabled={!nameOk || password.length < PERSONAL_PASSWORD_MIN} onClick={create}>
        Create account
      </DoorButton>
      <DoorButton tone="text" dataAttr="personal-account-google" disabled={!nameOk} onClick={withGoogle}>
        Continue with Google
      </DoorButton>
      {error ? (
        <p className="ps-error" role="alert" data-attr="personal-account-error">
          {error}
        </p>
      ) : null}
      {needsSignIn ? (
        <Link href="/auth/sign-in" className="ps-btn ps-btn-line" data-attr="personal-account-sign-in">
          Sign in
        </Link>
      ) : null}
    </DoorShell>
  );
}
