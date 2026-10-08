import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { filterAdminUserIds } from "@/lib/auth/admin-role";
import { normalizePortalRoles } from "@/lib/auth/portal-roles";
import type { ViewAsPortal } from "@/lib/auth/view-as-token";
import {
  isTrustedTestWorkspaceOperatorId,
  resolveTestWorkspaceClassification,
} from "@/lib/test-workspaces/index.server";

/**
 * May this operator open a "View as" session on this account in this portal?
 * Pure decision over the service-role client so the start route and the admin
 * UI's portal list share one rule. Every refusal is a generic, non-enumerating
 * message: a probe must not learn why an account is off limits.
 */
export type ViewAsStartDecision =
  | { ok: true; name: string; email: string | null }
  | { ok: false; status: 400 | 403 | 404; error: string };

const REFUSED_TARGET = "That account cannot be viewed.";

export async function listViewablePortals(
  db: SupabaseClient,
  args: { operatorId: string; targetId: string },
): Promise<{ ok: true; portals: ViewAsPortal[]; name: string; email: string | null } | { ok: false }> {
  const targetId = args.targetId.trim();
  if (!targetId || targetId === args.operatorId) return { ok: false };

  const { data: profile, error } = await db
    .from("profiles")
    .select("id, email, full_name, role, application_approved")
    .eq("id", targetId)
    .maybeSingle();
  if (error || !profile) return { ok: false };
  const p = profile as {
    id: string;
    email: string | null;
    full_name: string | null;
    role: string | null;
    application_approved: boolean | null;
  };
  // Disabled accounts (the Accounts "Disable account" switch) are off limits.
  if (p.application_approved === false) return { ok: false };

  // Purged / deleted: the login must still exist and not be banned.
  try {
    const { data: authData, error: authError } = await db.auth.admin.getUserById(targetId);
    const authUser = authData?.user as { banned_until?: string | null } | null | undefined;
    if (authError || !authUser) return { ok: false };
    if (authUser.banned_until && Date.parse(authUser.banned_until) > Date.now()) return { ok: false };
  } catch {
    return { ok: false };
  }

  const admins = await filterAdminUserIds(db, [targetId]);
  if (admins.has(targetId)) return { ok: false };

  // A durable test-workspace member is viewable only by a test-workspace operator.
  const classification = await resolveTestWorkspaceClassification(targetId, db);
  if (classification.kind === "classified" && !isTrustedTestWorkspaceOperatorId(args.operatorId)) {
    return { ok: false };
  }

  const { data: roleRows } = await db.from("profile_roles").select("role").eq("user_id", targetId);
  const roles = normalizePortalRoles(roleRows as { role: string }[] | null, p.role);
  const portals = roles.filter((r): r is ViewAsPortal => r === "manager" || r === "resident" || r === "vendor");
  return { ok: true, portals, name: p.full_name?.trim() || p.email || "this account", email: p.email };
}

export async function decideViewAsStart(
  db: SupabaseClient,
  args: { operatorId: string; targetId: string; portal: ViewAsPortal },
): Promise<ViewAsStartDecision> {
  const viewable = await listViewablePortals(db, args);
  if (!viewable.ok) return { ok: false, status: 400, error: REFUSED_TARGET };
  if (!viewable.portals.includes(args.portal)) return { ok: false, status: 400, error: REFUSED_TARGET };
  return { ok: true, name: viewable.name, email: viewable.email };
}
