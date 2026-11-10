import { NativeAuthHub } from "@/components/auth/native-auth-hub";
import { loadSharedLineConfig } from "@/lib/one-number/config.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

// The shared-line rollout is a runtime switch, never a build-time snapshot.
export const dynamic = "force-dynamic";

async function readPhoneFirstPreference(): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const config = await Promise.race([
      loadSharedLineConfig(createSupabaseServiceRoleClient()),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 1500); }),
    ]);
    return config?.mode === "shared";
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
