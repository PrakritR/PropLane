import { NativeAuthHub } from "@/components/auth/native-auth-hub";
import { loadSharedLineConfig } from "@/lib/one-number/config.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

// The shared-line rollout is a runtime switch, never a build-time snapshot.
export const dynamic = "force-dynamic";

/**
 * Universal sign-in surface (web + native): OAuth and email/password.
 * Account creation is role-agnostic at /auth/create-account, then /auth/get-started.
 */
export default async function SignInPage() {
  let phoneFirst = false;
  try {
    phoneFirst = (await loadSharedLineConfig(createSupabaseServiceRoleClient())).mode === "shared";
  } catch {
    // A missing service configuration keeps the legacy sign-in surface available.
  }
  return <NativeAuthHub defaultMode="sign-in" phoneFirst={phoneFirst} />;
}
