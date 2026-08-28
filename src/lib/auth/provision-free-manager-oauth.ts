import { ensureFreeManagerPortalAccess } from "@/lib/auth/manager-portal-provision";
import type { SupabaseClient, User } from "@supabase/supabase-js";

/** Google OAuth identity or Gmail address (legacy signups). */
export function isGoogleOrGmailAccount(user: User): boolean {
  const email = user.email?.trim().toLowerCase() ?? "";
  if (email.endsWith("@gmail.com")) return true;
  if ((user.identities ?? []).some((i) => i.provider === "google")) return true;
  const provider = user.app_metadata?.provider;
  if (provider === "google") return true;
  const providers = user.app_metadata?.providers;
  if (Array.isArray(providers) && providers.includes("google")) return true;
  return false;
}

/**
 * Creates or completes a free manager portal account for an OAuth user.
 * Idempotent — safe to call on every Google sign-in and during admin backfill.
 */
export async function provisionFreeManagerFromOAuth(
  supabase: SupabaseClient,
  user: User,
): Promise<{ provisioned: boolean; managerId?: string }> {
  if (!isGoogleOrGmailAccount(user)) return { provisioned: false };

  const result = await ensureFreeManagerPortalAccess(supabase, user, { trialForNewManager: false });
  if (result.status === "skipped") return { provisioned: false };
  return { provisioned: result.provisioned, managerId: result.managerId };
}

/** Backfill manager portal rows for Google/Gmail auth users missing from admin lists. */
export async function backfillOrphanGoogleOAuthManagers(
  supabase: SupabaseClient,
): Promise<{ scanned: number; provisioned: number }> {
  let scanned = 0;
  let provisioned = 0;
  let page = 1;
  const perPage = 200;

  for (;;) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    const users = data.users ?? [];
    if (users.length === 0) break;

    for (const user of users) {
      scanned += 1;
      if (!isGoogleOrGmailAccount(user)) continue;
      const result = await provisionFreeManagerFromOAuth(supabase, user);
      if (result.provisioned) provisioned += 1;
    }

    if (users.length < perPage) break;
    page += 1;
  }

  return { scanned, provisioned };
}
