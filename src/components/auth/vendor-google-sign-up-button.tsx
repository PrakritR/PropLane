"use client";

import { GoogleSignInButton } from "@/components/auth/google-sign-in-button";
import {
  persistVendorSignupInviteToken,
  persistVendorSignupNext,
} from "@/lib/auth/vendor-oauth-storage";

export function VendorGoogleSignUpButton({
  inviteToken,
  nextPath = "/vendor/onboarding",
  disabled = false,
}: {
  /** When signing up from a manager invite link, the token is forwarded through OAuth. */
  inviteToken?: string;
  nextPath?: string;
  disabled?: boolean;
}) {
  const trimmedToken = inviteToken?.trim() ?? "";
  const trimmedNext = nextPath?.trim() ?? "";

  return (
    <GoogleSignInButton
      label="Continue with Google"
      intent="vendor"
      fixedCallbackPath="/auth/callback/vendor-signup"
      viaContinue={false}
      disabled={disabled}
      onBeforeRedirect={() => {
        if (trimmedToken) persistVendorSignupInviteToken(trimmedToken);
        if (trimmedNext.startsWith("/")) persistVendorSignupNext(trimmedNext);
      }}
    />
  );
}
