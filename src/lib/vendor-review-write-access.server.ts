import "server-only";

import { linkedOwnerScopeForModule } from "@/lib/auth/co-manager-module-scope";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

type ServiceClient = ReturnType<typeof createSupabaseServiceRoleClient>;

/**
 * Whether `actorUserId` may write a vendor review on behalf of the workspace
 * owned by `ownerManagerUserId`: the owner always may; a co-manager needs the
 * `services` module granted at `edit` on the work order's own property — the
 * same gate `PORTAL_SECTION_CO_MANAGER_PERMISSION.vendors` maps to.
 */
export async function canActForVendorReviewWorkspace(
  db: ServiceClient,
  actorUserId: string,
  ownerManagerUserId: string,
  propertyId: string | null,
): Promise<boolean> {
  if (actorUserId === ownerManagerUserId) return true;
  if (!propertyId) return false;
  const scope = await linkedOwnerScopeForModule(db, actorUserId, "services", "edit");
  return scope.propertyIdsByOwner.get(ownerManagerUserId)?.has(propertyId) === true;
}
