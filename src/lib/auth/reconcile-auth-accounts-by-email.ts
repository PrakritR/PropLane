import { pendingAccountRecovery } from "@/lib/auth/account-recovery.server";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import type { User } from "@supabase/supabase-js";

type ServiceDb = ReturnType<typeof createSupabaseServiceRoleClient>;

function normalizeEmail(email: string | null | undefined): string {
  return email?.trim().toLowerCase() ?? "";
}

function oauthFullName(user: User): string | null {
  const meta = user.user_metadata ?? {};
  const fullName = typeof meta.full_name === "string" ? meta.full_name.trim() : "";
  if (fullName) return fullName;
  const name = typeof meta.name === "string" ? meta.name.trim() : "";
  return name || null;
}

async function syncProfileForUser(db: ServiceDb, user: User): Promise<void> {
  const email = normalizeEmail(user.email);
  if (!email) return;

  const { data: existing } = await db.from("profiles").select("*").eq("id", user.id).maybeSingle();
  if (!existing) return;

  const fullName = oauthFullName(user);
  const patch: { email: string; full_name?: string } = { email };
  if (!existing.full_name?.trim() && fullName) patch.full_name = fullName;
  const { error } = await db.from("profiles").update(patch).eq("id", user.id);
  if (error) throw error;
}

/**
 * Refresh the signed-in account's OWN profile contact fields, and nothing else.
 *
 * An email address is never treated as ownership of another account: a second auth user registered with
 * the same address is a separate account, so no row is migrated to it, no `manager_purchases` row is
 * claimed, no address is auto-confirmed, and no role is granted here - roles come from stored
 * `profile_roles` only, never from self-writable `user_metadata` or the legacy `profiles.role`.
 */
export async function reconcileAuthAccountsByEmail(db: ServiceDb, sessionUser: User): Promise<void> {
  if (!normalizeEmail(sessionUser.email) || !sessionUser.email_confirmed_at) return;
  if (await pendingAccountRecovery(db, sessionUser.id)) return;
  await syncProfileForUser(db, sessionUser);
}
