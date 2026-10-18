import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { userHoldsAdminRole } from "@/lib/auth/admin-role";
import { userIsPropertyPortalManager } from "@/lib/auth/co-manager-invite-eligibility.server";

/**
 * The PropLane SERVICE OWNER: the one designated account that owns every
 * "PropLane Service" workspace (admin Service tab). The workspaces are ordinary
 * `portal_workspaces` rows; other admin operators reach them as members with the
 * Admin role, so nothing about the manager portal changes.
 *
 * Ownership model (docs/agents/one-number.md § Admin service workspaces):
 *   * `platform_service_settings` (singleton row) is the source of truth - the
 *     database trigger needs it to exempt the owner from the workspace ceiling.
 *   * `PROPLANE_SERVICE_OWNER_USER_ID` only SEEDS that row, once, and only when it
 *     names an existing account that holds the admin role. A row, once present,
 *     always wins over the env var, so a changed env can never silently move
 *     ownership of existing workspaces.
 *   * No row and no valid env = "not configured": every caller fails closed.
 *   * The owner must ALSO be a property-portal manager account (`userIsPropertyPortalManager`): memberships are
 *     `account_link_invites` rows and the co-manager sweeper (`purgeOrphanedCoManagerLinks`) deletes any link whose
 *     inviter is not a valid manager account, which would silently strip every operator from every service
 *     workspace. An owner without that role reads as "not configured" for create / list.
 *
 * Nothing here is reachable from a request body; callers pass ids they derived.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MISSING_SCHEMA_CODES = new Set(["42P01", "42703", "PGRST204", "PGRST205"]);

export type ServiceOwnerResolution =
  | { ok: true; ownerUserId: string }
  | { ok: false; reason: "not_configured" | "unreadable" };

function missingSchema(error: { code?: string } | null | undefined): boolean {
  return Boolean(error?.code && MISSING_SCHEMA_CODES.has(error.code));
}

/** The stored service owner id, or null (no row, or the migration has not run here). Throws on a real read failure. */
async function readStoredOwner(db: SupabaseClient): Promise<string | null> {
  const { data, error } = await db
    .from("platform_service_settings")
    .select("owner_user_id")
    .eq("singleton", true)
    .maybeSingle();
  if (error) {
    if (missingSchema(error)) return null;
    throw new Error("service owner unreadable");
  }
  const id = String((data as { owner_user_id?: unknown } | null)?.owner_user_id ?? "").trim();
  return id || null;
}

/**
 * Resolve (and, from a valid env var, seed) the service owner. For the admin
 * Service routes only: it may write the singleton row.
 */
export async function resolveServiceOwner(
  db: SupabaseClient,
  env: Record<string, string | undefined> = process.env,
): Promise<ServiceOwnerResolution> {
  try {
    const stored = await readStoredOwner(db);
    if (stored) {
      return (await userIsPropertyPortalManager(db, stored))
        ? { ok: true, ownerUserId: stored }
        : { ok: false, reason: "not_configured" };
    }

    const candidate = (env.PROPLANE_SERVICE_OWNER_USER_ID ?? "").trim();
    if (!UUID.test(candidate)) return { ok: false, reason: "not_configured" };

    const { data: profile, error: profileError } = await db.from("profiles").select("id").eq("id", candidate).maybeSingle();
    if (profileError) return { ok: false, reason: "unreadable" };
    if (!profile) return { ok: false, reason: "not_configured" };
    if (!(await userHoldsAdminRole(db, candidate))) return { ok: false, reason: "not_configured" };
    if (!(await userIsPropertyPortalManager(db, candidate))) return { ok: false, reason: "not_configured" };

    const { error: seedError } = await db
      .from("platform_service_settings")
      .upsert({ singleton: true, owner_user_id: candidate }, { onConflict: "singleton", ignoreDuplicates: true });
    if (seedError) return { ok: false, reason: missingSchema(seedError) ? "not_configured" : "unreadable" };
    // Re-read: a concurrent seed with another id wins, and so do we.
    const after = await readStoredOwner(db);
    return after ? { ok: true, ownerUserId: after } : { ok: false, reason: "unreadable" };
  } catch {
    return { ok: false, reason: "unreadable" };
  }
}

/**
 * Whether `userId` is the stored service owner. Read-only and fail-closed: an
 * unreadable table, a missing migration or no row all answer false.
 */
export async function isPlatformServiceOwner(db: SupabaseClient, userId: string): Promise<boolean> {
  const id = userId.trim();
  if (!id) return false;
  try {
    return (await readStoredOwner(db)) === id;
  } catch {
    return false;
  }
}

export type ServiceWorkspaceRow = {
  id: string;
  name: string;
  city: string | null;
  ownerUserId: string;
  isDefault: boolean;
};

/**
 * The workspace when - and only when - it is a service workspace owned by the
 * stored service owner. The one test every Service route runs on the id it was
 * given: a body id of any other workspace, or of an ordinary manager's, is null.
 */
export async function loadServiceWorkspace(db: SupabaseClient, workspaceId: string): Promise<ServiceWorkspaceRow | null> {
  const id = workspaceId.trim();
  if (!UUID.test(id)) return null;
  let owner: string | null;
  try {
    owner = await readStoredOwner(db);
  } catch {
    return null;
  }
  if (!owner) return null;
  const { data, error } = await db
    .from("portal_workspaces")
    .select("id, name, city, owner_user_id, is_default, is_service")
    .eq("id", id)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as Record<string, unknown>;
  if (row.is_service !== true || String(row.owner_user_id ?? "") !== owner) return null;
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    city: typeof row.city === "string" && row.city.trim() ? row.city : null,
    ownerUserId: owner,
    isDefault: Boolean(row.is_default),
  };
}
