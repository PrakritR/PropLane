import "server-only";

import type { CoManagerPermissionId, CoManagerPermissionLevel } from "@/lib/co-manager-permissions";
import { linkedOwnerScopeForModule } from "@/lib/auth/co-manager-module-scope";
import { managerHasCoManagerPermissionForProperty } from "@/lib/auth/manager-lease-scope";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

type ServiceClient = ReturnType<typeof createSupabaseServiceRoleClient>;

export type CoManagerAccessResult =
  | { ok: true }
  | { ok: false; status: 403 | 404; error: string };

/**
 * Assert a manager (primary owner or co-manager) may access a module for a property.
 * Primary owners always pass. Co-managers must have the module permission on the property.
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
    if (ownerId) {
      return ownerId === userId ? { ok: true } : { ok: false, status: 403, error: "Forbidden." };
    }
    return { ok: true };
  }

  const allowed = await managerHasCoManagerPermissionForProperty(db, userId, pid, permission, opts?.level ?? "read");
  if (allowed) return { ok: true };
  return { ok: false, status: 403, error: "You do not have access to this section for this property." };
}

const NO_MODULE_ACCESS_ERROR = "You do not have access to this section for this property.";

/**
 * Assert module access WITHOUT the legacy empty-map sentinel.
 *
 * `assertCoManagerModuleAccess` resolves through
 * `managerHasCoManagerPermissionForProperty`, which still treats an assignment
 * carrying NO checked permissions as full access at every level. That is the
 * rule PRP-199 retired (`docs/agents/co-manager-access.md`), and
 * `coManagerModuleAllowed` — which `linkedOwnerScopeForModule` resolves through
 * — denies it. Surfaces that can read or rewrite another manager's money
 * settings must use this one.
 *
 * The owner pairing is checked too: a grant on `propertyId` only authorizes a
 * write attributed to the owner who issued it. An OWNERLESS row (the column is
 * `on delete set null`) has no owner to pair with, so the property grant alone
 * carries it — the same rule that keeps a co-manager working on a listing whose
 * manager account was deleted.
 */
export async function assertCoManagerModuleAccessStrict(
  db: ServiceClient,
  userId: string,
  propertyId: string | null | undefined,
  permission: CoManagerPermissionId,
  opts?: { ownerManagerUserId?: string | null; level?: CoManagerPermissionLevel },
): Promise<CoManagerAccessResult> {
  const pid = (propertyId ?? "").trim();
  const ownerId = (opts?.ownerManagerUserId ?? "").trim();

  if (ownerId && ownerId === userId) return { ok: true };
  if (!pid) return { ok: false, status: 403, error: NO_MODULE_ACCESS_ERROR };

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
