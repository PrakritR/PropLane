import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { NO_MODULE_ACCESS_ERROR, assertCoManagerModuleAccess } from "@/lib/auth/co-manager-access";
import { linkedOwnerScopeForModule } from "@/lib/auth/co-manager-module-scope";

export type WaiverScopeResult =
  | { ok: true; ownerUserId: string; callerIsOwner: boolean }
  | { ok: false; status: number; error: string };

/** {@link resolveWaiverPropertiesScope}: the same answer plus which of the asked ids still exist. */
export type WaiverPropertiesScopeResult =
  | { ok: true; ownerUserId: string; callerIsOwner: boolean; knownPropertyIds: string[] }
  | { ok: false; status: number; error: string };

/**
 * Whose waiver codes this request may read or write for one property.
 *
 * A waiver code belongs to the LISTING, so a co-manager assigned to it must see
 * and edit the same code the owner does — scoping to the caller gave them a
 * blank field, and any code they set was stored under their own id where
 * redemption (which looks codes up under the property's owner) could never find
 * it. An unowned or unknown property falls back to the caller, which is exactly
 * the previous behaviour and exposes nothing new.
 *
 * A co-manager holding `{}` on this property must not read or rewrite the
 * owner's waiver code, which is why `assertCoManagerModuleAccess` resolves
 * through `coManagerModuleAllowed` rather than the retired empty-means-full
 * sentinel.
 *
 * PropLane staff in a service (`is_service`) workspace are admitted by the same
 * rule: their seat is an accepted `account_link_invites` row (`is_service_seat`)
 * carrying `assigned_property_ids` + per-module levels, which is exactly what
 * `assertCoManagerModuleAccess` reads. No separate staff rule exists here.
 */
export async function resolveWaiverCodeScope(
  db: SupabaseClient,
  callerUserId: string,
  propertyId: string,
  level: "read" | "edit",
): Promise<WaiverScopeResult> {
  if (!propertyId) return { ok: true, ownerUserId: callerUserId, callerIsOwner: true };
  const { data } = await db
    .from("manager_property_records")
    .select("manager_user_id")
    .eq("id", propertyId)
    .maybeSingle();
  const ownerUserId = String((data as { manager_user_id?: string | null } | null)?.manager_user_id ?? "").trim();
  if (!ownerUserId || ownerUserId === callerUserId) {
    return { ok: true, ownerUserId: ownerUserId || callerUserId, callerIsOwner: true };
  }
  const access = await assertCoManagerModuleAccess(db as never, callerUserId, propertyId, "applications", {
    ownerManagerUserId: ownerUserId,
    level,
  });
  if (!access.ok) return { ok: false, status: access.status, error: access.error };
  return { ok: true, ownerUserId, callerIsOwner: false };
}

/**
 * The same decision for a LIST of properties (a code limited to several houses). Every id is re-read from the
 * database - an id in a body is a name, never a grant - and they must all belong to ONE owner, so a code can
 * never straddle two portfolios. The caller must be that owner or hold `applications` at `level` on each one.
 * Returns `ownerUserId` (whose code table the write belongs to) and `knownPropertyIds` (the ids that still
 * exist). An unknown or ownerless property is refused: with a list there is no "fall back to the caller"
 * because nothing says who the code would belong to.
 *
 * `ignoreUnknown` is for re-authorizing a list that is already STORED on a code rather than one that arrived in
 * a body. `manager_application_fee_waiver_codes.property_ids` has no foreign key, so a deleted house leaves a
 * stale id behind, and refusing the whole request over it would lock the code out of every later edit. A house
 * that no longer exists grants nothing and blocks nothing.
 *
 * The grant is resolved ONCE for the whole list (`linkedOwnerScopeForModule`) rather than per id: the per-id
 * gate re-read the property row and the caller's whole link graph for every entry, so a 20-house code cost
 * ~100 sequential queries. The per-id property-owner short-circuit inside that gate is redundant here - every
 * id was just read into `ownerById`, and a caller who owns them all has already returned above.
 */
export async function resolveWaiverPropertiesScope(
  db: SupabaseClient,
  callerUserId: string,
  propertyIds: readonly string[],
  level: "read" | "edit",
  opts: { ignoreUnknown?: boolean } = {},
): Promise<WaiverPropertiesScopeResult> {
  const asked = [...new Set(propertyIds.map((id) => id.trim()).filter(Boolean))];
  const nothing: WaiverPropertiesScopeResult = { ok: true, ownerUserId: callerUserId, callerIsOwner: true, knownPropertyIds: [] };
  if (asked.length === 0) return nothing;
  const { data, error } = await db.from("manager_property_records").select("id, manager_user_id").in("id", asked);
  if (error) return { ok: false, status: 500, error: "Could not check those properties just now. Try again." };
  const ownerById = new Map(
    ((data ?? []) as { id: string; manager_user_id?: string | null }[]).map((r) => [
      String(r.id),
      String(r.manager_user_id ?? "").trim(),
    ]),
  );
  const ids = opts.ignoreUnknown === true ? asked.filter((id) => Boolean(ownerById.get(id))) : asked;
  if (ids.length === 0) return nothing;
  if (ids.some((id) => !ownerById.get(id))) {
    return { ok: false, status: 400, error: "Pick properties from your own portfolio." };
  }
  const owners = new Set(ids.map((id) => ownerById.get(id)!));
  if (owners.size > 1) {
    return { ok: false, status: 400, error: "A code can only cover properties from one portfolio." };
  }
  const ownerUserId = [...owners][0]!;
  if (ownerUserId === callerUserId) return { ok: true, ownerUserId, callerIsOwner: true, knownPropertyIds: ids };
  const grant = await linkedOwnerScopeForModule(db as never, callerUserId, "applications", level);
  if (!ids.every((id) => grant.propertyIds.has(id)) || !grant.ownerIds.has(ownerUserId)) {
    return { ok: false, status: 403, error: NO_MODULE_ACCESS_ERROR };
  }
  return { ok: true, ownerUserId, callerIsOwner: false, knownPropertyIds: ids };
}
