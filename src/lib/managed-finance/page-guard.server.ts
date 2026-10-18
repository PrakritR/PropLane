import "server-only";

import { redirect } from "next/navigation";
import { getServerSessionProfile } from "@/lib/auth/server-profile";
import { listManagedWorkspacesForOwner } from "@/lib/owner-management/policies.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

/**
 * Page-level gate for `/portal/owner/finances`. Signed out goes to sign-in. Allowed: the owner of record of at least one
 * managed workspace, or someone with a fee agreement sent to them to sign (the same two conditions as `requireManagedOwner`
 * for the API). Anyone else is sent to their own dashboard.
 */
export async function requireManagedOwnerPage(): Promise<{ name: string | null; email: string | null }> {
  const { user, profile } = await getServerSessionProfile();
  if (!user) redirect("/auth/sign-in");
  let allowed = false;
  try {
    const db = createSupabaseServiceRoleClient();
    const workspaces = await listManagedWorkspacesForOwner(db, user.id);
    if (workspaces.length > 0) {
      allowed = true;
    } else {
      const { data } = await db
        .from("managed_workspace_fee_policies")
        .select("id")
        .eq("owner_user_id", user.id)
        .eq("status", "draft")
        .not("sent_at", "is", null)
        .limit(1);
      allowed = ((data ?? []) as unknown[]).length > 0;
    }
  } catch {
    // Unreadable: the page's own data comes from /api/owner/finances, which denies on its own.
    allowed = false;
  }
  if (!allowed) redirect("/portal/dashboard");
  return { name: profile?.full_name ?? null, email: profile?.email ?? user.email ?? null };
}
