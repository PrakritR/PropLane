"use client";

import posthog from "posthog-js";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { AuthAlreadyHaveRolePanel } from "@/components/auth/auth-already-have-role-panel";
import { AuthDivider, AuthLegalConsent } from "@/components/auth/auth-mobile-primitives";
import { ResidentAppleSignUpButton } from "@/components/auth/resident-apple-sign-up-button";
import { ResidentGoogleSignUpButton } from "@/components/auth/resident-google-sign-up-button";
import { useSignedInPortalRoles } from "@/components/auth/use-signed-in-portal-roles";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { FIELD_LABEL_CLASS } from "@/lib/ui-styles";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { isUnsafeRedirectPath } from "@/lib/auth/normalize-post-auth-path";
import { nativeAwarePath } from "@/lib/auth/native-auth-entry";
import { navigateAfterRoleSignup } from "@/lib/auth/navigate-after-role-signup";
import { normalizeAuthEmail } from "@/lib/auth/normalize-auth-email";

type RegisterResponse = {
  error?: string;
  redirectTo?: string;
  axisId?: string;
  linkedApplication?: boolean;
};

/**
 * Prospective-resident account creation — Google or email/phone/password. A renter
 * creates their account, then applies from inside their portal. `nextPath` carries
 * the listing context (e.g. `/rent/apply?propertyId=…`) so signup lands them on that
 * application, not an empty dashboard. Shares the auth-hub compact skeleton with the
 * manager/vendor signup forms.
 */
export function ResidentSignupForm({
  initialEmail = "",
  nextPath = "/resident/applications",
  axisId,
  variant = "default",
  disabled = false,
  hideLegalFooter = false,
}: {
  initialEmail?: string;
  /** Post-signup redirect — in-portal apply with a pre-selected property when present. */
  nextPath?: string;
  /** A manager application link may pass an Axis ID; signup links by email either way. */
  axisId?: string;
  variant?: "default" | "compact";
  disabled?: boolean;
  hideLegalFooter?: boolean;
}) {
  const router = useRouter();
  const [email, setEmail] = useState(initialEmail);
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A signed-in manager/vendor who lands here must NOT mint a second auth user
  // via self-serve signup — they add the resident role to their existing login
  // (the additive path owned by the multi-role lane). Only anonymous visitors
  // see the self-serve form. When they ALREADY hold the resident role, the form
  // makes no sense either — they get the shared "go to your portal" panel.
  const { email: signedInEmail, roles: portalRoles, loading: rolesLoading } = useSignedInPortalRoles();
  const alreadyResident = Boolean(signedInEmail) && portalRoles.includes("resident");

  const compact = variant === "compact";
  const locked = disabled || busy;
  // nextPath is URL-controlled — reject anything that would resolve
  // off-origin (protocol-relative, backslash, or obfuscated variants of
  // either) before it can reach `window.location.replace`.
  const resolvedNext = !isUnsafeRedirectPath(nextPath) ? nextPath : "/resident/applications";

  const addResidentRole = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/auth/create-resident-account", { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { redirectTo?: string; error?: string };
      if (!res.ok) {
        setError(body.error || "Could not add resident access. Please try again.");
        setBusy(false);
        return;
      }
      // Prefer the listing-context next; full navigation so the flipped
      // active-portal cookie + new resident role are re-read by the portal guard.
      const dest = resolvedNext !== "/resident/applications" ? resolvedNext : body.redirectTo || "/resident/applications/apply";
      window.location.assign(nativeAwarePath(dest));
    } catch {
      setError("Could not add resident access. Please try again.");
      setBusy(false);
    }
  };

  const submit = async () => {
    setError(null);
    if (!email.trim().includes("@")) {
      setError("Enter a valid email address.");
      return;
    }
    if (phone.replace(/\D/g, "").length < 10) {
      setError("Enter a valid phone number.");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/auth/resident-register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: normalizeAuthEmail(email), password, fullName: fullName.trim(), phone: phone.trim() }),
      });
      const body = (await res.json()) as RegisterResponse;
      if (!res.ok) {
        setError(body.error ?? "Could not create resident account.");
        return;
      }
      const supabase = createSupabaseBrowserClient();
      const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
        email: normalizeAuthEmail(email),
        password,
      });
      if (signInError) {
        // Preserve the resident intent + listing context so a manual sign-in
        // still lands them on this application, not a generic portal.
        router.push(`/auth/sign-in?intent=resident&next=${encodeURIComponent(resolvedNext)}`);
        return;
      }
      if (signInData?.user) posthog.identify(signInData.user.id);
      // When a listing context was passed (Create account from a listing's apply
      // gate), land the renter ON that application inside their portal. We go
      // straight there rather than through the post-auth resolver, which would
      // pick a generic portal path and drop the propertyId.
      if (resolvedNext !== "/resident/applications") {
        window.location.replace(nativeAwarePath(resolvedNext));
        return;
      }
      await navigateAfterRoleSignup(body.redirectTo?.startsWith("/") ? body.redirectTo : resolvedNext);
    } catch {
      setError("Could not create resident account.");
    } finally {
      setBusy(false);
    }
  };

  const socialBlock = (
    <div className="space-y-3">
      <ResidentAppleSignUpButton axisId={axisId} nextPath={resolvedNext} disabled={locked} />
      <ResidentGoogleSignUpButton axisId={axisId} nextPath={resolvedNext} disabled={locked} />
    </div>
  );

  const fieldsCompact = (
    <>
      <Input
        type="text"
        autoComplete="name"
        placeholder="Full name"
        value={fullName}
        onChange={(e) => setFullName(e.target.value)}
        disabled={locked}
      />
      <Input
        type="email"
        autoComplete="email"
        // iOS/macOS autocapitalise the first letter by default, which used to
        // make Manager@… a different account from manager@… (PRP-196).
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        placeholder="Email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        disabled={locked}
      />
      <Input
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        placeholder="Phone number"
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
        disabled={locked}
      />
      <PasswordInput
        autoComplete="new-password"
        placeholder="Password (8+ characters)"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        disabled={locked}
        onKeyDown={(e) => {
          if (e.key === "Enter") void submit();
        }}
      />
    </>
  );

  const fieldsDefault = (
    <>
      <div>
        <label className={FIELD_LABEL_CLASS} htmlFor="resident-name">
          Full name
        </label>
        <Input
          id="resident-name"
          type="text"
          className="mt-1.5"
          autoComplete="name"
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          disabled={locked}
        />
      </div>
      <div>
        <label className={FIELD_LABEL_CLASS} htmlFor="resident-email">
          Email
        </label>
        <Input
          id="resident-email"
          type="email"
          className="mt-1.5"
          autoComplete="email"
          // iOS/macOS autocapitalise the first letter by default, which used to
          // make Manager@… a different account from manager@… (PRP-196).
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={locked}
        />
      </div>
      <div>
        <label className={FIELD_LABEL_CLASS} htmlFor="resident-phone">
          Phone number
        </label>
        <Input
          id="resident-phone"
          type="tel"
          inputMode="tel"
          className="mt-1.5"
          autoComplete="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          disabled={locked}
        />
        <p className="mt-1 text-xs text-muted/70">Used for tenancy and account text updates. Reply STOP anytime.</p>
      </div>
      <div>
        <label className={FIELD_LABEL_CLASS} htmlFor="resident-password">
          Password
        </label>
        <PasswordInput
          id="resident-password"
          className="mt-1.5"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={locked}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
        />
      </div>
    </>
  );

  const tagline = (
    <p className="text-center text-[11px] leading-tight text-muted sm:text-xs">
      Free resident account · track and apply from your portal.
    </p>
  );

  if (rolesLoading) {
    return (
      <div className={compact ? "resident-signup-form space-y-2.5 sm:space-y-3" : "space-y-4"}>
        {compact ? tagline : null}
      </div>
    );
  }

  // Signed in AND already a resident: the signup form makes no sense — send them
  // in, matching the manager/vendor "already have access" state.
  if (alreadyResident) {
    return (
      <div className={compact ? "resident-signup-form space-y-2.5 sm:space-y-3" : "space-y-4"}>
        {tagline}
        <AuthAlreadyHaveRolePanel role="resident" email={signedInEmail} />
        {!hideLegalFooter ? <AuthLegalConsent action="create" className="mt-2" /> : null}
      </div>
    );
  }

  // Signed-in manager/vendor without the resident role: no second auth user.
  // Offer the additive path (resident role on the same login) instead of the
  // self-serve form.
  if (signedInEmail) {
    return (
      <div className={compact ? "resident-signup-form space-y-2.5 sm:space-y-3" : "space-y-4"}>
        {tagline}
        <div className="rounded-2xl border border-border bg-card/50 px-3 py-3 text-center text-[13px] leading-snug text-muted">
          You&apos;re signed in as <span className="font-semibold text-foreground">{signedInEmail}</span>. Add resident
          access to your existing login: same email, no new password, its own resident portal. Switch back anytime
          without signing out.
        </div>
        <Button
          type="button"
          data-attr="resident-add-role-submit"
          className="btn-cobalt w-full rounded-full py-2.5 text-[15px] font-semibold"
          disabled={locked}
          onClick={() => addResidentRole()}
        >
          {busy ? "Setting up…" : "Add resident access & apply"}
        </Button>
        {error ? <p className="text-center text-xs text-rose-600">{error}</p> : null}
        {!hideLegalFooter ? <AuthLegalConsent action="create" className="mt-2" /> : null}
      </div>
    );
  }

  if (compact) {
    return (
      <div className="resident-signup-form space-y-2.5 sm:space-y-3">
        {tagline}

        {socialBlock}

        <AuthDivider label="or enter your details" />

        {fieldsCompact}

        <Button
          type="button"
          data-attr="resident-signup-submit"
          className="btn-cobalt w-full rounded-full py-2.5 text-[15px] font-semibold"
          disabled={locked}
          onClick={() => submit()}
          event="resident_signup_submitted"
        >
          {busy ? "Creating…" : "Create resident account"}
        </Button>

        {error ? <p className="text-center text-xs text-rose-600">{error}</p> : null}

        {!hideLegalFooter ? <AuthLegalConsent action="create" className="mt-2" /> : null}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {socialBlock}
      <AuthDivider label="or enter your details" />
      {fieldsDefault}
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <Button
        type="button"
        className="w-full rounded-full py-3 text-base font-semibold"
        onClick={() => submit()}
        disabled={locked}
        data-attr="resident-signup-submit"
        event="resident_signup_submitted"
      >
        {busy ? "Creating account…" : "Create resident account"}
      </Button>
      {!hideLegalFooter ? <AuthLegalConsent action="create" className="mt-2" /> : null}
    </div>
  );
}
