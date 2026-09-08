import { withRecoveredStorageReads } from "@/lib/auth/account-recovery-storage";
import { createClient } from "@supabase/supabase-js";
import { assertNonProdDatabase } from "@/lib/server-env";

/** Service role — server-only (webhooks, privileged signup). Never import in client code. */
export function createSupabaseServiceRoleClient() {
  assertNonProdDatabase();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  if (!/^https:\/\/[a-z0-9]+\.supabase\.co\/?$/i.test(url)) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL looks invalid (expected https://<project-ref>.supabase.co).",
    );
  }
  return withRecoveredStorageReads(createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  }));
}
