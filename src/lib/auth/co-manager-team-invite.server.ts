import "server-only";

import { findPropertyIdsNotOwnedByManager } from "@/lib/auth/co-manager-invite-scope";
import {
  collectLinkedPropertyIdsForUser,
  collectLinkedPropertyPermissionsForUser,
  managerHasCoManagerPermissionForProperty,
} from "@/lib/auth/manager-lease-scope";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import {
  coManagerPermissionsExceedGrant,
  intersectCoManagerPermissions,
  normalizePropertyCoManagerPermissions,
  permissionsForProperty,
  type PropertyCoManagerPermissions,
} from "@/lib/co-manager-permissions";

type ServiceClient = ReturnType<typeof createSupabaseServiceRoleClient>;

export type TeamInviteDelegateResult =
  | { ok: true; ownerUserId: string }
  | { ok: false; status: number; error: string };

/**
 * Resolve which owner an invite link or addressed invite is minted under.
 * Primary owners invite for themselves; co-managers need `teams` edit on every
 * selected property and all properties must belong to one owner.
 */
export async function resolveTeamInviteDelegate(
  db: ServiceClient,
  actorUserId: string,
  propertyIds: string[],
): Promise<TeamInviteDelegateResult> {
  const unique = [...new Set(propertyIds.map((id) => String(id).trim()).filter(Boolean))];
  if (unique.length === 0) {
    return { ok: false, status: 400, error: "Choose at least one property this link grants access to." };
  }

  const owned = await findPropertyIdsNotOwnedByManager(db, actorUserId, unique);
  if (!owned.ok) {
    return { ok: false, status: 500, error: "Could not verify property ownership. Try again." };
  }
  if (owned.unowned.length === 0) {
    return { ok: true, ownerUserId: actorUserId };
  }

  const { data: rows, error } = await db
    .from("manager_property_records")
    .select("id, manager_user_id")
    .in("id", unique);
  if (error) {
    return { ok: false, status: 500, error: "Could not verify property ownership. Try again." };
  }

  const ownerByProperty = new Map<string, string>();
  for (const row of rows ?? []) {
    const id = String((row as { id?: unknown }).id ?? "").trim();
    const ownerId = String((row as { manager_user_id?: unknown }).manager_user_id ?? "").trim();
    if (id && ownerId) ownerByProperty.set(id, ownerId);
  }

  let ownerUserId: string | null = null;
  for (const propertyId of unique) {
    const propertyOwnerId = ownerByProperty.get(propertyId);
    if (!propertyOwnerId) {
      return {
        ok: false,
        status: 403,
        error: "One or more selected properties are not available for team invites.",
      };
    }
    if (!ownerUserId) ownerUserId = propertyOwnerId;
    if (ownerUserId !== propertyOwnerId) {
      return {
        ok: false,
        status: 400,
        error: "Choose properties from one manager account per invite.",
      };
    }
    const allowed = await managerHasCoManagerPermissionForProperty(
      db,
      actorUserId,
      propertyId,
      "teams",
      "edit",
    );
    if (!allowed) {
      return {
        ok: false,
        status: 403,
        error: "You do not have Team permission to invite co-managers for one or more selected properties.",
      };
    }
  }

  if (!ownerUserId) {
    return { ok: false, status: 403, error: "You do not have permission to send team invites." };
  }
  return { ok: true, ownerUserId };
}

/** Owner ids whose active invite links this actor may list, mint, copy, or revoke. */
export async function teamInviteOwnerIdsForActor(db: ServiceClient, actorUserId: string): Promise<Set<string>> {
  const owners = new Set<string>([actorUserId.trim()]);
  const linkedIds = await collectLinkedPropertyIdsForUser(db, actorUserId);
  for (const propertyId of linkedIds) {
    const allowed = await managerHasCoManagerPermissionForProperty(
      db,
      actorUserId,
      propertyId,
      "teams",
      "edit",
    );
    if (!allowed) continue;
    const { data } = await db
      .from("manager_property_records")
      .select("manager_user_id")
      .eq("id", propertyId)
      .maybeSingle();
    const ownerId = String(data?.manager_user_id ?? "").trim();
    if (ownerId) owners.add(ownerId);
  }
  return owners;
}

export async function actorCanManageInviteLink(
  db: ServiceClient,
  actorUserId: string,
  input: { ownerUserId: string; assignedPropertyIds: string[] },
): Promise<boolean> {
  const ownerUserId = input.ownerUserId.trim();
  if (!ownerUserId) return false;
  if (ownerUserId === actorUserId.trim()) return true;
  const delegate = await resolveTeamInviteDelegate(db, actorUserId, input.assignedPropertyIds);
  return delegate.ok && delegate.ownerUserId === ownerUserId;
}

export type TeamInvitePermissionsCapResult =
  | { ok: true; permissions: PropertyCoManagerPermissions }
  | { ok: false; status: number; error: string };

/**
 * Co-managers may invite only within their own per-property grants. Owners pass
 * through unchanged; delegates exceeding their grant are refused.
 */
export async function capTeamInvitePermissionsForDelegate(
  db: ServiceClient,
  actorUserId: string,
  ownerUserId: string,
  propertyIds: string[],
  requested: PropertyCoManagerPermissions,
): Promise<TeamInvitePermissionsCapResult> {
  const normalized = normalizePropertyCoManagerPermissions(requested, propertyIds);
  if (actorUserId.trim() === ownerUserId.trim()) {
    return { ok: true, permissions: normalized };
  }

  const linked = await collectLinkedPropertyPermissionsForUser(db, actorUserId);
  const capped: PropertyCoManagerPermissions = {};

  for (const propertyId of propertyIds) {
    const actorFlat = permissionsForProperty(linked.get(propertyId), propertyId);
    const requestedFlat = normalized[propertyId] ?? {};
    if (coManagerPermissionsExceedGrant(actorFlat, requestedFlat)) {
      return {
        ok: false,
        status: 403,
        error: "You cannot grant module access beyond what you have on one or more selected properties.",
      };
    }
    capped[propertyId] = intersectCoManagerPermissions(actorFlat, requestedFlat);
  }

  return { ok: true, permissions: capped };
}
