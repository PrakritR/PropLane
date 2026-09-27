import "server-only";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

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
