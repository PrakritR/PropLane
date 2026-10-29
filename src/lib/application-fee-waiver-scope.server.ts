import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { waiverCodeLimitedPropertyIds } from "@/lib/application-fee-waiver";
import { NO_MODULE_ACCESS_ERROR } from "@/lib/auth/co-manager-access";
import { linkedOwnerScopeForModule, type LinkedOwnerScope } from "@/lib/auth/co-manager-module-scope";

export type WaiverScopeResult =
  | { ok: true; ownerUserId: string; callerIsOwner: boolean }
  | { ok: false; status: number; error: string };

/** {@link resolveWaiverPropertiesScope}: the same answer plus which of the asked ids still exist. */
export type WaiverPropertiesScopeResult =
  | { ok: true; ownerUserId: string; callerIsOwner: boolean; knownPropertyIds: string[] }
  | { ok: false; status: number; error: string };

/** The caller's `applications` link graph at one level. Call it as often as you like; it reads at most once. */
export type WaiverGrantReader = (level: "read" | "edit") => Promise<LinkedOwnerScope>;

/**
 * ONE link-graph read per request, shared by every gate below.
 *
 * Resolving a co-manager's grant costs ~4 sequential queries (`profiles`, `account_link_invites`, the service
 * seats, the inviters' `profiles`), and a single promo-code request asks the same question up to three times:
 * the list/entry gate, the widen gate, and the read-only stamp. Thread one reader through them and they share
 * the answer. Memoized per level, because a `read` gate and an `edit` gate are different questions - but see
 * {@link grantCovers}, which asks `edit` first precisely so the common caller only ever needs the one.
 *
 * Caller-scoped by construction: the reader closes over `callerUserId`, so it can never answer for another
 * user, and it lives no longer than the request that made it.
 */
export function createWaiverGrantReader(db: SupabaseClient, callerUserId: string): WaiverGrantReader {
  const byLevel = new Map<string, Promise<LinkedOwnerScope>>();
  return (level) => {
    const hit = byLevel.get(level);
    if (hit) return hit;
    const pending = linkedOwnerScopeForModule(db as never, callerUserId, "applications", level);
    byLevel.set(level, pending);
    return pending;
  };
}

/**
 * Does the caller hold `applications` at `level` on EVERY one of `ids`, granted by `ownerUserId`?
 *
 * `propertyIdsByOwner` pairs the house with the owner who granted it, so a grant from one manager can never
 * authorize acting on another manager's code - the same pairing `assertCoManagerModuleAccess` makes, in one
 * lookup instead of two.
 *
 * `edit` is asked first even for a `read` gate: an `edit` grant implies `read` (`grantAllows` answers "read"
 * for an edit-only grant), so a teammate who can write needs no second graph read, and the stamp that follows
 * reuses the very same answer. Only a genuinely read-only teammate pays for the second level.
 */
async function grantCovers(
  grant: WaiverGrantReader,
  ownerUserId: string,
  ids: readonly string[],
  level: "read" | "edit",
): Promise<boolean> {
  const editable = (await grant("edit")).propertyIdsByOwner.get(ownerUserId) ?? new Set<string>();
  if (ids.every((id) => editable.has(id))) return true;
  if (level === "edit") return false;
  const readable = (await grant("read")).propertyIdsByOwner.get(ownerUserId) ?? new Set<string>();
  return ids.every((id) => readable.has(id));
}

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
 * owner's waiver code, which is why the decision resolves through
 * `coManagerModuleAllowed` (inside `linkedOwnerScopeForModule`) rather than the
 * retired empty-means-full sentinel.
 *
 * PropLane staff in a service (`is_service`) workspace are admitted by the same
 * rule: their seat is an accepted `account_link_invites` row (`is_service_seat`)
 * carrying `assigned_property_ids` + per-module levels, which is exactly what
 * that graph reads. No separate staff rule exists here.
 *
 * The grant check is {@link grantCovers}, shared with
 * {@link resolveWaiverPropertiesScope}: one house is just a list of one, and
 * two gates answering the same question two ways is how they drift. It replaces
 * `assertCoManagerModuleAccess`, whose own property-row read duplicated the one
 * right above it.
 */
export async function resolveWaiverCodeScope(
  db: SupabaseClient,
  callerUserId: string,
  propertyId: string,
  level: "read" | "edit",
  grant: WaiverGrantReader = createWaiverGrantReader(db, callerUserId),
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
  if (!(await grantCovers(grant, ownerUserId, [propertyId], level))) {
    return { ok: false, status: 403, error: NO_MODULE_ACCESS_ERROR };
  }
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
 * The grant is resolved ONCE for the whole list ({@link grantCovers}) rather than per id: the per-id gate
 * re-read the property row and the caller's whole link graph for every entry, so a 20-house code cost ~100
 * sequential queries. The per-id property-owner short-circuit inside that gate is redundant here - every id was
 * just read into `ownerById`, and a caller who owns them all has already returned above. Pass `grant` to share
 * one link-graph read with the rest of the request.
 */
export async function resolveWaiverPropertiesScope(
  db: SupabaseClient,
  callerUserId: string,
  propertyIds: readonly string[],
  level: "read" | "edit",
  opts: { ignoreUnknown?: boolean; grant?: WaiverGrantReader } = {},
): Promise<WaiverPropertiesScopeResult> {
  const grant = opts.grant ?? createWaiverGrantReader(db, callerUserId);
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
  if (!(await grantCovers(grant, ownerUserId, ids, level))) {
    return { ok: false, status: 403, error: NO_MODULE_ACCESS_ERROR };
  }
  return { ok: true, ownerUserId, callerIsOwner: false, knownPropertyIds: ids };
}

/** Which houses of `ownerUserId` the caller may WRITE applications on, and which of `propertyIds` still exist. */
export type WaiverWriteScope = {
  editable: Set<string>;
  existing: Set<string>;
  /**
   * The "does this house still exist" read failed, so `existing` is a guess, not an answer. Every non-owner
   * code reads as read-only while this is set: a scope we cannot substantiate must never present itself as
   * permission.
   */
  unavailable: boolean;
};

/**
 * One read each for "does this house still exist" and "may I write applications on it", for the whole set of
 * houses a list of codes covers. Resolved once per request so {@link waiverCodeIsReadOnly} can answer for every
 * listed code without a query per code, let alone per house.
 *
 * Both halves fail CLOSED, and they must agree on the direction. `linkedOwnerScopeForModule` swallows its own
 * errors into empty sets, which marks a row read-only; dropping the property read's `error` did the opposite -
 * an empty `existing` made every covered house read as deleted, so nothing was left to compare against the
 * grant and a code the caller could not write came back fully editable. On a failed read every asked house is
 * therefore treated as live, which is the answer that withholds controls rather than offering dead ones.
 */
export async function resolveWaiverWriteScope(
  db: SupabaseClient,
  callerUserId: string,
  ownerUserId: string,
  propertyIds: readonly string[],
  grant: WaiverGrantReader = createWaiverGrantReader(db, callerUserId),
): Promise<WaiverWriteScope> {
  const ids = [...new Set(propertyIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) return { editable: new Set(), existing: new Set(), unavailable: false };
  const [{ data, error }, edit] = await Promise.all([
    db.from("manager_property_records").select("id").in("id", ids),
    grant("edit"),
  ]);
  const editable = edit.propertyIdsByOwner.get(ownerUserId) ?? new Set<string>();
  if (error) return { editable, existing: new Set(ids), unavailable: true };
  return { editable, existing: new Set(((data ?? []) as { id: string }[]).map((r) => String(r.id))), unavailable: false };
}

/**
 * This code is listed for the caller but they may not change it, so the row shows its terms with no controls.
 *
 * Two shapes qualify, and both are exactly what `PATCH /[id]` refuses: a portfolio-wide code (the owner's alone,
 * 404 to anybody else), and a code covering a house the caller holds no `applications: edit` on (403). Offering
 * an edit that comes back refused is worse than showing none, so the two decisions are derived from one rule.
 *
 * A house that no longer exists is ignored on both sides, matching the `ignoreUnknown` write gates: a deleted
 * house grants nothing and blocks nothing. A code left covering ONLY deleted houses is therefore writable - it
 * is also unlistable, because it covers no house anybody can open.
 *
 * A scope that could not be resolved (`unavailable`) makes every code read-only. The row still shows what it
 * waives; what it withholds is a control whose write we cannot promise.
 */
export function waiverCodeIsReadOnly(
  code: { propertyId?: string | null; propertyIds?: readonly string[] | null },
  scope: WaiverWriteScope,
): boolean {
  if (scope.unavailable) return true;
  const limited = waiverCodeLimitedPropertyIds(code);
  if (limited.length === 0) return true;
  return limited.filter((id) => scope.existing.has(id)).some((id) => !scope.editable.has(id));
}
