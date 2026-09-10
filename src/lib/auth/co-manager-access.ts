import "server-only";

import type { CoManagerPermissionId, CoManagerPermissionLevel } from "@/lib/co-manager-permissions";
import { linkedOwnerScopeForModule } from "@/lib/auth/co-manager-module-scope";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

type ServiceClient = ReturnType<typeof createSupabaseServiceRoleClient>;

export type CoManagerAccessResult =
  | { ok: true }
  | { ok: false; status: 403 | 404; error: string };

const NO_MODULE_ACCESS_ERROR = "You do not have access to this section for this property.";

/**
 * THE gate: may this manager use `permission` at `level` on this property?
 *
 * Primary owners always pass. Everyone else needs the module POSITIVELY granted
 * on that property, resolved through `linkedOwnerScopeForModule` →
 * `coManagerModuleAllowed`. It deliberately does NOT go through
 * `managerHasCoManagerPermissionForProperty`, which still reads an assignment
 * carrying no checked permissions as full access at every level — the
 * empty-means-full sentinel PRP-199 retired (`docs/agents/co-manager-access.md`).
 * There is one gate rather than a lenient and a strict one, because the next
 * route author picks the obvious name.
 *
 * "Primary owner" is resolved two ways, and both are needed. A caller that
 * already read the row's owner passes it in and short-circuits; a caller that
 * did not — bills POST passes `undefined` on purpose, so that the property's
 * real owner is resolved server-side rather than taken on trust — is matched
 * against the property record itself. Without that second lookup an owner
 * creating a bill on their OWN house is refused, because
 * `linkedOwnerScopeForModule` reads `account_link_invites` by
 * `invitee_user_id` and an owner is the inviter, never the invitee.
 *
 * The owner is paired with the grant too: a grant on `propertyId` authorizes
 * acting on rows belonging to the owner who issued it, not to some third
 * manager. A row with NO owner (columns are `on delete set null`, so a deleted
 * manager leaves rows genuinely ownerless) has nothing to pair with, and the
 * property grant alone carries it.
 *
 * With no property named there is nothing to scope: an owner mismatch is still
 * refused, and a caller acting on their own unassigned row still passes.
 */
export async function assertCoManagerModuleAccess(
  db: ServiceClient,
  userId: string,
  propertyId: string | null | undefined,
  permission: CoManagerPermissionId,
  opts?: { ownerManagerUserId?: string | null; level?: CoManagerPermissionLevel },
): Promise<CoManagerAccessResult> {
  const pid = (propertyId ?? "").trim();
  const ownerId = (opts?.ownerManagerUserId ?? "").trim();

  if (ownerId && ownerId === userId) return { ok: true };
  if (!pid) {
    if (ownerId) return { ok: false, status: 403, error: "Forbidden." };
    return { ok: true };
  }

  const { data: propertyRow } = await db
    .from("manager_property_records")
    .select("manager_user_id")
    .eq("id", pid)
    .maybeSingle();
  const propertyOwnerId = String(
    (propertyRow as { manager_user_id?: string | null } | null)?.manager_user_id ?? "",
  ).trim();
  if (propertyOwnerId && propertyOwnerId === userId) return { ok: true };

  const { ownerIds, propertyIds } = await linkedOwnerScopeForModule(
    db,
    userId,
    permission,
    opts?.level ?? "read",
  );
  if (!propertyIds.has(pid)) return { ok: false, status: 403, error: NO_MODULE_ACCESS_ERROR };
  if (ownerId && !ownerIds.has(ownerId)) return { ok: false, status: 403, error: NO_MODULE_ACCESS_ERROR };
  return { ok: true };
}

/** Map finances API routes to the financials module permission. */
export async function assertManagerFinancialsCoManagerAccess(
  db: ServiceClient,
  userId: string,
  propertyId: string | null | undefined,
  ownerManagerUserId?: string | null,
  level: CoManagerPermissionLevel = "read",
): Promise<CoManagerAccessResult> {
  return assertCoManagerModuleAccess(db, userId, propertyId, "financials", { ownerManagerUserId, level });
}

/** Map document routes to the documents module permission. */
export async function assertManagerDocumentsCoManagerAccess(
  db: ServiceClient,
  userId: string,
  propertyId: string | null | undefined,
  ownerManagerUserId?: string | null,
  level: CoManagerPermissionLevel = "read",
): Promise<CoManagerAccessResult> {
  return assertCoManagerModuleAccess(db, userId, propertyId, "documents", { ownerManagerUserId, level });
}

/** Map promotion routes to the promotion module permission. */
export async function assertManagerPromotionCoManagerAccess(
  db: ServiceClient,
  userId: string,
  propertyId: string | null | undefined,
  ownerManagerUserId?: string | null,
  level: CoManagerPermissionLevel = "read",
): Promise<CoManagerAccessResult> {
  return assertCoManagerModuleAccess(db, userId, propertyId, "promotion", { ownerManagerUserId, level });
}

/** Map services / work-order routes to the services module permission. */
export async function assertManagerServicesCoManagerAccess(
  db: ServiceClient,
  userId: string,
  propertyId: string | null | undefined,
  ownerManagerUserId?: string | null,
  level: CoManagerPermissionLevel = "read",
): Promise<CoManagerAccessResult> {
  return assertCoManagerModuleAccess(db, userId, propertyId, "services", { ownerManagerUserId, level });
}
