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

  const fullName = oauthFullName(user);
  const { data: existing } = await db.from("profiles").select("*").eq("id", user.id).maybeSingle();

  if (existing) {
    const patch: { email: string; full_name?: string } = { email };
    if (!existing.full_name?.trim() && fullName) patch.full_name = fullName;
    const { error } = await db.from("profiles").update(patch).eq("id", user.id);
    if (error) throw error;
    return;
  }

}

/** Synchronize this verified Auth user's own existing profile only. */
export async function reconcileAuthAccountsByEmail(db: ServiceDb, sessionUser: User): Promise<void> {
  const email = normalizeEmail(sessionUser.email);
  if (!email || !sessionUser.email_confirmed_at) return;

  if (await pendingAccountRecovery(db, sessionUser.id)) return;
  await syncProfileForUser(db, sessionUser);


}
