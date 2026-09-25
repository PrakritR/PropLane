import { createClient } from "@supabase/supabase-js";
import { assertNonProdDatabase } from "@/lib/server-env";
import { EXISTING_ACCOUNT_PASSWORD_MISMATCH } from "@/lib/auth/existing-account-password-mismatch";

export { EXISTING_ACCOUNT_PASSWORD_MISMATCH };

/**
 * Confirms `password` is correct for the auth user with this email (stateless; no cookies).
 * Use when linking a new manager signup to an existing Supabase user — never overwrite their password.
 */
export async function assertPasswordMatchesExistingAuthUser(
  email: string,
  password: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  assertNonProdDatabase();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    return { ok: false, message: "Server configuration error." };
  }

  const normalEmail = email.trim().toLowerCase();
  const client = createClient(url, anon, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  const { error } = await client.auth.signInWithPassword({
    email: normalEmail,
    password,
  });

  await client.auth.signOut({ scope: "local" });

  if (!error) {
    return { ok: true };
  }

  const msg = error.message.toLowerCase();
  if (msg.includes("email not confirmed")) {
    return {
      ok: false,
      message: "Confirm your email on the existing account before continuing with this signup.",
    };
  }

  return { ok: false, message: EXISTING_ACCOUNT_PASSWORD_MISMATCH };
}
