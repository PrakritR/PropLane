import { getEffectiveUserIdForPortal } from "@/lib/auth/effective-session";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { normalizePortalRoles } from "@/lib/auth/portal-roles";
import { postgrestFilterValue } from "@/lib/supabase/or-filter";
import {
  assertTestWorkspacePrincipalCompatibility,
  resolveAuthenticatedBusinessAccess,
} from "@/lib/test-workspaces/index.server";

export const MANAGER_INBOX_SCOPE = "axis_portal_inbox_manager_v1";
export const RESIDENT_INBOX_SCOPE = "axis_portal_inbox_resident_v1";
export const VENDOR_INBOX_SCOPE = "axis_portal_inbox_vendor_v1";
export const ADMIN_INBOX_SCOPE = "admin";

export type InboxScopeUser = {
  id: string;
  email: string | null;
  role: string;
  /**
   * The caller's own display name. A turn appended to a row the caller does NOT
   * own is attributed from here, never from the body - `from` is what a human
   * reads as the sender, so trusting the client let a co-manager write a turn
   * that displays as the owner speaking.
   */
  name?: string | null;
};

export type PortalInboxThreadScopeOptions = {
  /**
   * Manager Communication: the viewer's email matches only LEGACY rows written
   * with no owner. A thread another owner holds never reaches a manager's inbox
   * just because the manager is the person it was sent to — that owner never
   * invited them. Resident / vendor / admin scopes keep the plain match.
   */
  participantOnlyWhenUnowned?: boolean;
};

/** PostgREST OR filter for inbox row ownership (matches GET visibility). */
export function portalInboxThreadScopeFilter(
  user: InboxScopeUser,
  extraOwnerIds: string[] = [],
  options: PortalInboxThreadScopeOptions = {},
): string {
  const ownerIds = [...new Set([user.id, ...extraOwnerIds.map((id) => id.trim()).filter(Boolean)])];
  // Owner ids are auth user ids (uuids from the session / grant tables), never
  // free text. The email IS free text, so it is quoted: data, never filter syntax.
  const clauses: string[] =
    ownerIds.length <= 1
      ? [`owner_user_id.eq.${ownerIds[0] ?? user.id}`]
      : [`owner_user_id.in.(${ownerIds.join(",")})`];
  if (user.email) {
    const email = postgrestFilterValue(user.email);
    clauses.push(
      options.participantOnlyWhenUnowned
        ? `and(owner_user_id.is.null,participant_email.eq.${email})`
        : `participant_email.eq.${email}`,
    );
  }
  if (user.role === "admin") clauses.push(`scope.eq.${ADMIN_INBOX_SCOPE}`);
  return clauses.join(",");
}

export function applyPortalInboxThreadScope<T>(
  query: T,
  user: InboxScopeUser,
  extraOwnerIds: string[] = [],
  options: PortalInboxThreadScopeOptions = {},
): T {
  const q = query as { or: (expr: string) => unknown };
  return q.or(portalInboxThreadScopeFilter(user, extraOwnerIds, options)) as T;
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
  if ((await resolveAuthenticatedBusinessAccess(authUser.id, db)).kind === "denied") return null;
  const { data: profile } = await db.from("profiles").select("email, role, full_name").eq("id", authUser.id).maybeSingle();
  const admin = await isAdminUser(authUser.id);

  let actorId = authUser.id;
  let actorEmail = (profile?.email ?? authUser.email ?? "").trim().toLowerCase() || null;
  let actorName = String(profile?.full_name ?? "").trim() || null;
  const role = admin ? "admin" : String(profile?.role ?? authUser.user_metadata?.role ?? "").toLowerCase();

  if (admin && scope !== ADMIN_INBOX_SCOPE) {
    const portal = portalForScope(scope);
    if (portal) {
      const effectiveId = await getEffectiveUserIdForPortal(portal);
      if (effectiveId && effectiveId !== authUser.id) {
        await assertTestWorkspacePrincipalCompatibility({
          actorUserId: authUser.id,
          relatedUserIds: [effectiveId],
          db,
        });
        actorId = effectiveId;
        const { data: effectiveProfile } = await db
          .from("profiles")
          .select("email, full_name")
          .eq("id", effectiveId)
          .maybeSingle();
        actorEmail = (effectiveProfile?.email ?? "").trim().toLowerCase() || null;
        actorName = String(effectiveProfile?.full_name ?? "").trim() || null;
      }
    }
  }

  return {
    db,
    user: { id: actorId, email: actorEmail, role, name: actorName },
  };
}

/**
 * May this caller WRITE a row into `scope`? A scope names whose inbox a row
 * lands in, so it has to match a portal the caller really holds (profile_roles,
 * legacy profiles.role as the fallback) - and the admin inbox is admin-only.
 * Everything else is refused, so an unknown scope string never reaches the table.
 */
export async function callerMayWriteInboxScope(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  user: InboxScopeUser,
  scope: string,
): Promise<boolean> {
  if (scope === ADMIN_INBOX_SCOPE) return user.role === "admin";
  const portal = portalForScope(scope);
  if (!portal) return false;
  if (user.role === "admin") return true;
  const { data } = await db.from("profile_roles").select("role").eq("user_id", user.id);
  const roles = normalizePortalRoles((data ?? []) as { role: string }[], user.role);
  return roles.includes(portal);
}
