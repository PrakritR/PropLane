"use client";

import posthog from "posthog-js";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { AuthAlreadyHaveRolePanel } from "@/components/auth/auth-already-have-role-panel";
import { AuthDivider, AuthLegalConsent } from "@/components/auth/auth-mobile-primitives";
import { AuthSignedInRoleBanner } from "@/components/auth/auth-signed-in-role-banner";
import { useSignedInPortalRoles } from "@/components/auth/use-signed-in-portal-roles";
import { VendorAppleSignUpButton } from "@/components/auth/vendor-apple-sign-up-button";
import { VendorGoogleSignUpButton } from "@/components/auth/vendor-google-sign-up-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { queuePendingNotice, VENDOR_PORTAL_PATH } from "@/lib/pending-notice";
import { FIELD_LABEL_CLASS } from "@/lib/ui-styles";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { navigateAfterRoleSignup } from "@/lib/auth/navigate-after-role-signup";
import { normalizeAuthEmail } from "@/lib/auth/normalize-auth-email";

type RegisterResponse = {
  error?: string;
  redirectTo?: string;
  confirmed?: boolean;
  emailDeliveryConfigured?: boolean;
  confirmLinkLoggedLocally?: boolean;
  /** Signup succeeded but a stale invite could not be redeemed — say why. */
  unlinkedReason?: string | null;
  unlinkedNotice?: string | null;
};

/** Vendor account creation — Google or email/password; reused in auth hub, invite page, and public marketing. */
export function VendorSignupForm({
  inviteToken,
  initialEmail = "",
  initialFullName = "",
  nextPath = "/vendor/dashboard",
  variant = "default",
  disabled = false,
  hideLegalFooter = false,
}: {
  inviteToken?: string;
  initialEmail?: string;
  initialFullName?: string;
  nextPath?: string;
  /** Hub-style signup matches resident create-account layout. */
  variant?: "default" | "compact";
  disabled?: boolean;
  hideLegalFooter?: boolean;
}) {
  const router = useRouter();
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingConfirmation, setPendingConfirmation] = useState(false);
  const [localDevConfirmHint, setLocalDevConfirmHint] = useState(false);
  const [inviteNotice, setInviteNotice] = useState<string | null>(null);
  const { email: signedInEmail, roles: portalRoles, loading: rolesLoading } = useSignedInPortalRoles();
  // A signed-in account that already holds the vendor role gets the shared
  // "go to your portal" panel instead of a signup form it can't sensibly use;
  // "Create a different vendor account" reveals the form again so the ability to
  // spin up a separate vendor account is preserved.
  const alreadyVendor = Boolean(signedInEmail) && portalRoles.includes("vendor");
  const [creatingAnother, setCreatingAnother] = useState(false);
  const showAddRoleBanner = Boolean(signedInEmail) && !alreadyVendor;

  const compact = variant === "compact";
  const locked = disabled || busy;
  const resolvedNext = nextPath.startsWith("/") ? nextPath : "/vendor/dashboard";

  const submit = async () => {
    setError(null);
    if (compact && !inviteToken && (!email.trim() || password.length < 8)) {
      setError("Enter your email and an 8+ character password.");
      return;
    }
    if (!inviteToken && !email.trim().includes("@")) {
      setError("Enter a valid email address.");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/auth/vendor-register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          inviteToken
            ? { token: inviteToken, password, fullName: initialFullName.trim() || undefined }
            : { email: normalizeAuthEmail(email), password },
        ),
      });
      const body = (await res.json()) as RegisterResponse;
      if (!res.ok) {
        setLocalDevConfirmHint(body.confirmLinkLoggedLocally === true);
        setError(body.error ?? "Could not create vendor account.");
        return;
      }

      const unlinkedNotice = body.unlinkedReason ? (body.unlinkedNotice ?? null) : null;

      if (body.confirmed === false) {
        setPendingConfirmation(true);
        setLocalDevConfirmHint(false);
        setInviteNotice(unlinkedNotice);
        return;
      }

      const supabase = createSupabaseBrowserClient();
      const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
        email: normalizeAuthEmail(email),
        password,
      });
      if (signInError) {
        router.push("/auth/sign-in");
        return;
      }
      if (signInData?.user) posthog.identify(signInData.user.id);
      const fallback = body.redirectTo?.startsWith("/") ? body.redirectTo : resolvedNext;
      // Queued only here, on the one exit that actually reloads the page — the
      // sign-in-error and throw branches must not leave a notice behind for an
      // unrelated navigation later in the session to surface.
      if (unlinkedNotice) queuePendingNotice({ message: unlinkedNotice, pathPrefix: VENDOR_PORTAL_PATH });
      await navigateAfterRoleSignup(fallback);
    } catch {
      setError("Could not create vendor account.");
    } finally {
      setBusy(false);
    }
  };

  if (pendingConfirmation) {
    return (
      <div>
        <h3 className="text-lg font-semibold text-foreground">Check your email</h3>
        <p className="mt-2 text-sm text-muted">
          We sent a confirmation link to <strong>{email.trim()}</strong>. Click it to finish creating your vendor
          account.
        </p>
        {inviteNotice ? <p className="mt-3 text-sm text-muted">{inviteNotice}</p> : null}
      </div>
    );
  }

  const socialBlock = (
    <div className="space-y-3">
      <VendorAppleSignUpButton inviteToken={inviteToken} nextPath={resolvedNext} disabled={locked} />
      <VendorGoogleSignUpButton inviteToken={inviteToken} nextPath={resolvedNext} disabled={locked} />
    </div>
  );

  const passwordFieldsCompact = (
    <>
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
        disabled={Boolean(inviteToken) || locked}
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

  const passwordFieldsDefault = (
    <>
      <div>
        <label className={FIELD_LABEL_CLASS} htmlFor="vendor-email">
          Email
        </label>
        <Input
          id="vendor-email"
          type="email"
          className="mt-1.5"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={Boolean(inviteToken) || locked}
        />
      </div>
      <div>
        <label className={FIELD_LABEL_CLASS} htmlFor="vendor-password">
          Password
        </label>
        <PasswordInput
          id="vendor-password"
          className="mt-1.5"
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
    <p className="text-center text-[11px] leading-tight text-muted whitespace-nowrap sm:text-xs">
      Free vendor account · services &amp; payouts through PropLane.
    </p>
  );

  if (rolesLoading) {
    return (
      <div className={compact ? "vendor-signup-form space-y-2.5 sm:space-y-3" : "space-y-4"}>
        {compact ? tagline : null}
      </div>
    );
  }

  if (alreadyVendor && !creatingAnother) {
    return (
      <div className={compact ? "vendor-signup-form space-y-2.5 sm:space-y-3" : "space-y-4"}>
        {compact ? tagline : null}
        <AuthAlreadyHaveRolePanel
          role="vendor"
          email={signedInEmail}
          onCreateAnother={() => setCreatingAnother(true)}
          createAnotherLabel="Create a different vendor account"
        />
        {!hideLegalFooter ? <AuthLegalConsent action="create" className="mt-2" /> : null}
      </div>
    );
  }

  if (compact) {
    return (
      <div className="vendor-signup-form space-y-2.5 sm:space-y-3">
        {tagline}

        {showAddRoleBanner ? <AuthSignedInRoleBanner role="vendor" email={signedInEmail} /> : null}

        {socialBlock}

        <AuthDivider label="or enter your details" />

        {passwordFieldsCompact}

        <Button
          type="button"
          data-attr="vendor-signup-submit"
          className="btn-cobalt w-full rounded-full py-2.5 text-[15px] font-semibold"
          disabled={locked}
          onClick={() => submit()}
          event="vendor_signup_submitted"
        >
          {busy ? "Creating…" : signedInEmail ? "Set up vendor account" : "Create vendor account"}
        </Button>

        {error ? <p className="text-center text-xs text-rose-600">{error}</p> : null}
        {localDevConfirmHint ? (
          <p className="text-center text-xs text-muted">
            Local dev only: check the server console for the confirmation link.
          </p>
        ) : null}

        {!hideLegalFooter ? <AuthLegalConsent action="create" className="mt-2" /> : null}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {showAddRoleBanner ? <AuthSignedInRoleBanner role="vendor" email={signedInEmail} /> : null}
      {socialBlock}
      <AuthDivider label="or enter your details" />
      {passwordFieldsDefault}
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      {localDevConfirmHint ? (
        <p className="text-xs text-muted">Local dev only: check the server console for the confirmation link.</p>
      ) : null}
      <Button
        type="button"
        className="w-full rounded-full py-3 text-base font-semibold"
        onClick={() => submit()}
        disabled={locked}
        data-attr="vendor-signup-submit"
        event="vendor_signup_submitted"
      >
        {busy ? "Creating account…" : signedInEmail ? "Set up vendor account" : "Create vendor account"}
      </Button>
      {!hideLegalFooter ? <AuthLegalConsent action="create" className="mt-2" /> : null}
    </div>
  );
}
