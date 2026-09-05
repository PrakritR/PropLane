export type SignInErrorPresentation = {
  message: string;
  credentialMismatch: boolean;
};

export const SIGN_IN_CREDENTIAL_MISMATCH_MESSAGE =
  "That email and password do not match an account. Check your details, reset your password, or create an account.";

/**
 * Turns provider errors into product language without becoming an account-existence oracle.
 *
 * Supabase deliberately gives the same response for a wrong password and an unknown email.
 * Keep those cases indistinguishable here: do not add an account lookup or copy that claims
 * the email is or is not registered. The recovery paths work for either case.
 */
export function presentSignInError(raw: string): SignInErrorPresentation {
  const message = raw.trim() || "Sign-in failed. Please try again.";
  const lower = message.toLowerCase();
  const credentialMismatch =
    lower.includes("invalid login credentials") || lower.includes("invalid credentials");

  if (credentialMismatch) {
    return {
      message: SIGN_IN_CREDENTIAL_MISMATCH_MESSAGE,
      credentialMismatch: true,
    };
  }

  // Supabase's raw "Email not confirmed" is provider language and reads as a
  // system fault rather than an inbox to check. Not an existence oracle: it is
  // only ever returned for an account the caller just proved the password for.
  if (lower.includes("email not confirmed")) {
    return {
      message: "This account hasn't been confirmed yet. Check your email for the confirmation link.",
      credentialMismatch: false,
    };
  }

  if (lower.includes("failed to fetch") || lower.includes("network") || lower.includes("fetch")) {
    return {
      message: "We could not reach PropLane. Check your connection and try again.",
      credentialMismatch: false,
    };
  }

  return { message, credentialMismatch: false };
}
