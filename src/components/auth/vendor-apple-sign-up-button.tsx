"use client";

import { AppleSignInButton } from "@/components/auth/apple-sign-in-button";
import {
  persistVendorSignupInviteToken,
  persistVendorSignupNext,
} from "@/lib/auth/vendor-oauth-storage";

export function VendorAppleSignUpButton({
  inviteToken,
  nextPath = "/vendor/onboarding",
  disabled = false,
}: {
  inviteToken?: string;
  nextPath?: string;
  disabled?: boolean;
}) {
  const trimmedToken = inviteToken?.trim() ?? "";
  const trimmedNext = nextPath?.trim() ?? "";

  return (
    <AppleSignInButton
      label="Continue with Apple"
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
