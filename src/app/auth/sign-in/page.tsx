import { NativeAuthHub } from "@/components/auth/native-auth-hub";
import { phoneSignInEnabled } from "@/lib/auth/phone-auth.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

// Phone sign-in works in every line mode; whether it is on is a runtime read, never a build-time snapshot.
export const dynamic = "force-dynamic";

async function readPhoneFirstPreference(): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const enabled = await Promise.race([
      phoneSignInEnabled(createSupabaseServiceRoleClient()),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 1500); }),
    ]);
    return enabled === true;
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Universal sign-in surface (web + native): OAuth and email/password.
 * Account creation is role-agnostic at /auth/create-account, then /auth/get-started.
 */
export default async function SignInPage() {
  const phoneFirst = await readPhoneFirstPreference();
  return <NativeAuthHub defaultMode="sign-in" phoneFirst={phoneFirst} />;
}
