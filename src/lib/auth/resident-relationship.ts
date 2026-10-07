import "server-only";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { NOT_PROPERTY_OWNER_LINK_FILTER } from "@/lib/co-manager-team-roles";

type ServiceClient = ReturnType<typeof createSupabaseServiceRoleClient>;

type ResidentTarget = {
  email?: string | null;
  residentUserId?: string | null;
};

/**
 * Collect the requestor's user id plus any workspace user ids they are linked to
 * via accepted account_link_invites (covers owners linked to a manager). Used so
 * a linked owner can act on the residents of their linked manager workspace.
 */
async function relatedWorkspaceUserIds(db: ServiceClient, requestorUserId: string): Promise<string[]> {
  const ids = new Set<string>([requestorUserId]);
  try {
    const { data } = await db
      .from("account_link_invites")
      .select("inviter_user_id, invitee_user_id, status")
      .eq("status", "accepted")
      .or(NOT_PROPERTY_OWNER_LINK_FILTER)
      .or(`inviter_user_id.eq.${requestorUserId},invitee_user_id.eq.${requestorUserId}`);
    for (const row of (data ?? []) as { inviter_user_id?: unknown; invitee_user_id?: unknown }[]) {
      if (typeof row.inviter_user_id === "string" && row.inviter_user_id.trim()) ids.add(row.inviter_user_id.trim());
      if (typeof row.invitee_user_id === "string" && row.invitee_user_id.trim()) ids.add(row.invitee_user_id.trim());
    }
  } catch {
    // Table may not exist in some environments; fall back to requestor only.
  }
  return [...ids];
}

async function tableLinksResident(
  db: ServiceClient,
  table: string,
  managerIds: string[],
  target: ResidentTarget,
): Promise<boolean> {
  const email = target.email?.trim().toLowerCase() || "";
  const residentUserId = target.residentUserId?.trim() || "";
  if (!email && !residentUserId) return false;

  const orFilters: string[] = [];
  if (email) orFilters.push(`resident_email.eq.${email}`);
  if (residentUserId) orFilters.push(`resident_user_id.eq.${residentUserId}`);

  try {
    const { data, error } = await db
      .from(table)
      .select("id")
      .in("manager_user_id", managerIds)
      .or(orFilters.join(","))
      .limit(1);
    if (error) return false;
    return Array.isArray(data) && data.length > 0;
  } catch {
    return false;
  }
}

/**
 * Returns true when the resident identified by email / user id is tied to the
 * requestor (or a workspace they are linked to) through an application, a
 * household charge, or a lease pipeline record. Admins should bypass this check
 * before calling. Defaults closed on any error.
 */
export async function managerOwnsResident(
  db: ServiceClient,
  requestorUserId: string,
  target: ResidentTarget,
): Promise<boolean> {
  if (!requestorUserId) return false;
  const email = target.email?.trim().toLowerCase() || "";
  const residentUserId = target.residentUserId?.trim() || "";
  if (!email && !residentUserId) return false;

  const managerIds = await relatedWorkspaceUserIds(db, requestorUserId);

  if (email) {
    try {
      const { data } = await db
        .from("manager_application_records")
        .select("id")
        .in("manager_user_id", managerIds)
        .eq("resident_email", email)
        .limit(1);
      if (Array.isArray(data) && data.length > 0) return true;
    } catch {
      // ignore and try other sources
    }
  }

  if (await tableLinksResident(db, "portal_household_charge_records", managerIds, target)) return true;
  if (await tableLinksResident(db, "portal_lease_pipeline_records", managerIds, target)) return true;

  return false;
}

/**
 * The property ids tying this resident to the requestor (or a workspace they
 * are linked to), across the same three tables `managerOwnsResident` checks
 * in the same order. NEVER used to decide "does this caller own the resident"
 * — that stays `managerOwnsResident`'s job — only to further narrow an
 * ALREADY-authorized relationship to the caller's active workspace, the same
 * way every other module scopes a positively-granted row. Defaults to an
 * empty list on any error, matching every other resolver's fail-closed
 * narrowing contract (nothing found means nothing to widen into).
 */
export async function residentPropertyIdsForManager(
  db: ServiceClient,
  requestorUserId: string,
  target: ResidentTarget,
): Promise<string[]> {
  const email = target.email?.trim().toLowerCase() || "";
  const residentUserId = target.residentUserId?.trim() || "";
  if (!requestorUserId || (!email && !residentUserId)) return [];

  const managerIds = await relatedWorkspaceUserIds(db, requestorUserId);
  const ids = new Set<string>();

  if (email) {
    try {
      const { data } = await db
        .from("manager_application_records")
        .select("property_id, assigned_property_id")
        .in("manager_user_id", managerIds)
        .eq("resident_email", email);
      for (const row of (data ?? []) as { property_id?: unknown; assigned_property_id?: unknown }[]) {
        const pid = String(row.property_id ?? "").trim();
        const apid = String(row.assigned_property_id ?? "").trim();
        if (pid) ids.add(pid);
        if (apid) ids.add(apid);
      }
    } catch {
      // ignore and try other sources
    }
  }

  const orFilters: string[] = [];
  if (email) orFilters.push(`resident_email.eq.${email}`);
  if (residentUserId) orFilters.push(`resident_user_id.eq.${residentUserId}`);
  if (orFilters.length > 0) {
    for (const table of ["portal_household_charge_records", "portal_lease_pipeline_records"] as const) {
      try {
        const { data } = await db
          .from(table)
          .select("property_id")
          .in("manager_user_id", managerIds)
          .or(orFilters.join(","));
        for (const row of (data ?? []) as { property_id?: unknown }[]) {
          const pid = String(row.property_id ?? "").trim();
          if (pid) ids.add(pid);
        }
      } catch {
        // ignore and try other sources
      }
    }
  }

  return [...ids];
}

/**
 * What a sender may reach right now, per the same rules the inbox applies to
 * what they may SEE: the active workspace narrows, and another owner's people
 * are reachable only through a house the sender holds Communication edit on.
 */
export type RecipientReach = {
  /** Houses in the active workspace; null = the account is not narrowing. */
  workspaceHouseIds: ReadonlySet<string> | null;
  /** Whether a person tied to no house belongs to the active workspace (its owner's default). */
  untaggedOk: boolean;
  /** For each OTHER owner: the houses the sender holds Communication edit on. */
  grantedHousesByOwner: ReadonlyMap<string, ReadonlySet<string>>;
  /** The active workspace, when the account is partitioned. */
  activeWorkspaceId?: string | null;
};

/** Is a person tied to `ownerId`'s house `houseId` inside the sender's reach? */
export function recipientInReach(
  requestorUserId: string,
  ownerId: string,
  houseId: string,
  reach: RecipientReach | undefined,
): boolean {
  if (ownerId !== requestorUserId) {
    // Another owner's people need an explicit grant on the very house.
    if (!reach) return false;
    const granted = reach.grantedHousesByOwner.get(ownerId);
    if (!granted || !houseId || !granted.has(houseId)) return false;
    return reach.workspaceHouseIds === null || reach.workspaceHouseIds.has(houseId);
  }
  if (!reach || reach.workspaceHouseIds === null) return true;
  return houseId ? reach.workspaceHouseIds.has(houseId) : reach.untaggedOk;
}

function houseOf(row: { property_id?: unknown; assigned_property_id?: unknown; row_data?: unknown }): string {
  const rowData = (row.row_data && typeof row.row_data === "object" ? row.row_data : {}) as Record<string, unknown>;
  return String(
    row.assigned_property_id ?? rowData.assignedPropertyId ?? row.property_id ?? rowData.propertyId ?? "",
  ).trim();
}

/**
 * Is this resident connected to the sender by a row the SENDER cannot simply
 * write? An application the resident submitted or a lease. Household charges and the co-manager "relationship" mirror are
 * client-writable (`residentEmail` is free text), so they prove nothing - a
 * fresh account used to add a fake charge naming anyone and then message them.
 *
 * Owners considered: the sender, and each owner the sender is an accepted
 * co-manager of - and only through the houses `reach` grants. The reverse
 * (the sender's own co-managers' residents) is never unioned in.
 */
export async function managerHasAuthoritativeResidentLink(
  db: ServiceClient,
  requestorUserId: string,
  target: ResidentTarget,
  reach?: RecipientReach,
): Promise<boolean> {
  if (!requestorUserId) return false;
  const email = target.email?.trim().toLowerCase() || "";
  const residentUserId = target.residentUserId?.trim() || "";
  if (!email && !residentUserId) return false;

  const owners = [requestorUserId, ...(reach ? [...reach.grantedHousesByOwner.keys()] : [])];

  if (email) {
    try {
      const { data } = await db
        .from("manager_application_records")
        .select("manager_user_id, property_id, assigned_property_id, row_data")
        .in("manager_user_id", owners)
        .eq("resident_email", email);
      for (const row of (data ?? []) as { manager_user_id?: unknown; row_data?: unknown }[]) {
        if (recipientInReach(requestorUserId, String(row.manager_user_id ?? ""), houseOf(row), reach)) return true;
      }
    } catch {
      // fall through to the lease pipeline
    }
  }

  const leaseKeys: Array<[string, string]> = [];
  if (email) leaseKeys.push(["resident_email", email]);
  if (residentUserId) leaseKeys.push(["resident_user_id", residentUserId]);
  for (const [column, value] of leaseKeys) {
    try {
      const { data } = await db
        .from("portal_lease_pipeline_records")
        .select("manager_user_id, property_id, row_data")
        .in("manager_user_id", owners)
        .eq(column, value);
      for (const row of (data ?? []) as { manager_user_id?: unknown; row_data?: unknown }[]) {
        if (recipientInReach(requestorUserId, String(row.manager_user_id ?? ""), houseOf(row), reach)) return true;
      }
    } catch {
      // ignore
    }
  }
  return false;
}
