import { isPrimaryAdminEmail } from "@/lib/auth/primary-admin";
import { primaryRoleWhenAddingResident } from "@/lib/auth/profile-primary-role";
import { provisionFreeManagerFromOAuth } from "@/lib/auth/provision-free-manager-oauth";
import type { SupabaseClient, User } from "@supabase/supabase-js";

function oauthFullName(user: User): string | null {
  const meta = user.user_metadata ?? {};
  const fullName = typeof meta.full_name === "string" ? meta.full_name.trim() : "";
  if (fullName) return fullName;
  const name = typeof meta.name === "string" ? meta.name.trim() : "";
  return name || null;
}

export type SyncOAuthProfileOptions = {
  /** Skip auto free-manager provisioning (manager pricing / finish signup flows). */
  skipAutoProvision?: boolean;
};

/** Ensures profiles/profile_roles reflect an OAuth sign-in. */
export async function syncOAuthProfile(
  supabase: SupabaseClient,
  user: User,
  opts?: SyncOAuthProfileOptions,
): Promise<void> {
  const email = user.email?.trim().toLowerCase() ?? "";
  if (!email) return;

  const fullName = oauthFullName(user);
  // The ops admin is admin-ONLY. It must never be auto-provisioned a free
  // manager portal (its address is a Workspace/Gmail identity, so it would
  // otherwise match isGoogleOrGmailAccount and pick up a manager role on every
  // Google sign-in).
  const isPrimaryAdmin = isPrimaryAdminEmail(email);
  const { data: existing } = await supabase.from("profiles").select("*").eq("id", user.id).maybeSingle();

  if (existing) {
    const patch: { email: string; full_name?: string } = { email };
    if (!existing.full_name?.trim() && fullName) patch.full_name = fullName;
    const { error } = await supabase.from("profiles").update(patch).eq("id", user.id);
    if (error) throw error;
    if (isPrimaryAdmin) return;
    if (!opts?.skipAutoProvision) {
      await provisionFreeManagerFromOAuth(supabase, user);
    }
    return;
  }

  if (isPrimaryAdmin) {
    // The ops address is admin-ONLY and its roles come from stored `profile_roles` alone, so nothing
    // is granted here. The profiles row itself still has to exist: `profiles.email` is what
    // `holdsAdminOutsideRoleRow` reads to enforce the primary-admin protection, and without the row
    // the account has no recorded email or name anywhere. The legacy `role` column is NOT NULL and
    // carries no authority (`AGENTS.md` § `profiles.role` is legacy), so it gets the same default a
    // brand-new profile with no portal chosen yet gets — never a fresh `admin` label, which the
    // release's own follow-up on stale legacy admin markers exists to stop spreading.
    const { error: profileError } = await supabase.from("profiles").upsert(
      { id: user.id, email, full_name: fullName, role: primaryRoleWhenAddingResident(null), manager_id: null },
      { onConflict: "id", ignoreDuplicates: true },
    );
    if (profileError) throw profileError;
    return;
  }

  if (!opts?.skipAutoProvision) {
    await provisionFreeManagerFromOAuth(supabase, user);
  }
}
