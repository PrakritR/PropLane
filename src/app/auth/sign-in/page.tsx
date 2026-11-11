import { NativeAuthHub } from "@/components/auth/native-auth-hub";
import { readPhoneSignInPreference } from "@/lib/auth/phone-sign-in-preference.server";

// Phone sign-in works in every line mode; whether it is on is a runtime read, never a build-time snapshot.
export const dynamic = "force-dynamic";

/**
 * Universal sign-in surface (web + native): OAuth and email/password.
 * Account creation is role-agnostic at /auth/create-account, then /auth/get-started.
 */
export default async function SignInPage() {
  const phoneFirst = await readPhoneSignInPreference();
  return <NativeAuthHub defaultMode="sign-in" phoneFirst={phoneFirst} />;
}
