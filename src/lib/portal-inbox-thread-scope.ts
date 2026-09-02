import { getEffectiveUserIdForPortal } from "@/lib/auth/effective-session";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const MANAGER_INBOX_SCOPE = "axis_portal_inbox_manager_v1";
export const RESIDENT_INBOX_SCOPE = "axis_portal_inbox_resident_v1";
export const VENDOR_INBOX_SCOPE = "axis_portal_inbox_vendor_v1";
export const ADMIN_INBOX_SCOPE = "admin";

export type InboxScopeUser = { id: string; email: string | null; role: string };

/** PostgREST OR filter for inbox row ownership (matches GET visibility). */
export function portalInboxThreadScopeFilter(
  user: InboxScopeUser,
  extraOwnerIds: string[] = [],
): string {
  const ownerIds = [...new Set([user.id, ...extraOwnerIds.map((id) => id.trim()).filter(Boolean)])];
  const clauses: string[] =
    ownerIds.length <= 1
      ? [`owner_user_id.eq.${ownerIds[0] ?? user.id}`]
      : [`owner_user_id.in.(${ownerIds.join(",")})`];
  if (user.email) clauses.push(`participant_email.eq.${user.email}`);
  if (user.role === "admin") clauses.push(`scope.eq.${ADMIN_INBOX_SCOPE}`);
  return clauses.join(",");
}

export function applyPortalInboxThreadScope<T>(
  query: T,
  user: InboxScopeUser,
  extraOwnerIds: string[] = [],
): T {
  const q = query as { or: (expr: string) => unknown };
  return q.or(portalInboxThreadScopeFilter(user, extraOwnerIds)) as T;
}

function portalForScope(scope: string): "manager" | "resident" | "vendor" | null {
  if (scope === MANAGER_INBOX_SCOPE) return "manager";
  if (scope === RESIDENT_INBOX_SCOPE) return "resident";
  if (scope === VENDOR_INBOX_SCOPE) return "vendor";
  return null;
}

/** Resolve the user whose inbox rows should be read/written (supports admin preview). */
export async function resolveInboxScopeUser(scope: string): Promise<{
  db: ReturnType<typeof createSupabaseServiceRoleClient>;
  user: InboxScopeUser;
} | null> {
  const auth = await createSupabaseServerClient();
  const {
    data: { user: authUser },
  } = await auth.auth.getUser();
  if (!authUser) return null;

  const db = createSupabaseServiceRoleClient();
  const { data: profile } = await db.from("profiles").select("email, role").eq("id", authUser.id).maybeSingle();
  const admin = await isAdminUser(authUser.id);

  let actorId = authUser.id;
  let actorEmail = (profile?.email ?? authUser.email ?? "").trim().toLowerCase() || null;
  const role = admin ? "admin" : String(profile?.role ?? authUser.user_metadata?.role ?? "").toLowerCase();

  if (admin && scope !== ADMIN_INBOX_SCOPE) {
    const portal = portalForScope(scope);
    if (portal) {
      const effectiveId = await getEffectiveUserIdForPortal(portal);
      if (effectiveId && effectiveId !== authUser.id) {
        actorId = effectiveId;
        const { data: effectiveProfile } = await db.from("profiles").select("email").eq("id", effectiveId).maybeSingle();
        actorEmail = (effectiveProfile?.email ?? "").trim().toLowerCase() || null;
      }
    }
  }

  return {
    db,
    user: { id: actorId, email: actorEmail, role },
  };
}
