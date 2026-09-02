import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { isCrossSandboxPortalPair } from "@/lib/portal-sandbox-accounts";
import { viewerAndLinkedOwnerIdsForModule } from "@/lib/auth/co-manager-module-scope";
import { samePhone, detectManagerSelfReply } from "@/lib/sms/manager-relay.server";
import { filterSmsInboxOwnerIds, type ManagerSmsAccess } from "@/lib/sms/manager-sms-access";
import type { AgentContext } from "@/lib/tools/context";
import { normalizeE164 } from "@/lib/phone-e164";

type LinkRow = {
  inviter_user_id?: string | null;
  assigned_property_ids?: unknown;
};

async function loadIncomingAssignedProperties(
  db: SupabaseClient,
  inviteeUserId: string,
  inviterUserId?: string,
): Promise<{ ownerIds: string[]; propertyIds: string[] }> {
  const ownerIds = new Set<string>();
  const propertyIds = new Set<string>();
  const invitee = inviteeUserId.trim();
  if (!invitee) return { ownerIds: [], propertyIds: [] };

  const { data: viewerProfile, error: viewerError } = await db
    .from("profiles")
    .select("email")
    .eq("id", invitee)
    .maybeSingle();
  if (viewerError) return { ownerIds: [], propertyIds: [] };
  const viewerEmail = String(viewerProfile?.email ?? "").trim();

  let query = db
    .from("account_link_invites")
    .select("inviter_user_id, assigned_property_ids")
    .eq("status", "accepted")
    .eq("invitee_user_id", invitee);
  if (inviterUserId?.trim()) query = query.eq("inviter_user_id", inviterUserId.trim());

  const { data: linkRows, error } = await query;
  if (error) return { ownerIds: [], propertyIds: [] };

  const inviterIds = [
    ...new Set(
      (linkRows ?? [])
        .map((row) => String((row as LinkRow).inviter_user_id ?? "").trim())
        .filter(Boolean),
    ),
  ];
  const inviterEmailById = new Map<string, string>();
  if (inviterIds.length > 0) {
    const { data: profiles, error: profileError } = await db
      .from("profiles")
      .select("id, email")
      .in("id", inviterIds);
    if (profileError) return { ownerIds: [], propertyIds: [] };
    for (const profile of profiles ?? []) {
      const id = String(profile.id ?? "").trim();
      const email = String(profile.email ?? "").trim();
      if (id && email) inviterEmailById.set(id, email);
    }
  }

  for (const row of (linkRows ?? []) as LinkRow[]) {
    const ownerId = String(row.inviter_user_id ?? "").trim();
    if (!ownerId) continue;
    if (isCrossSandboxPortalPair(viewerEmail, inviterEmailById.get(ownerId) ?? "")) continue;
    const assigned = Array.isArray(row.assigned_property_ids)
      ? row.assigned_property_ids
          .filter((id): id is string => typeof id === "string" && Boolean(id.trim()))
          .map((id) => id.trim())
      : [];
    if (assigned.length === 0) continue;
    ownerIds.add(ownerId);
    for (const id of assigned) propertyIds.add(id);
  }

  return { ownerIds: [...ownerIds], propertyIds: [...propertyIds] };
}

export async function resolveManagerSmsAccess(
  db: SupabaseClient,
  args: { actorUserId: string; workNumberOwnerId: string },
): Promise<ManagerSmsAccess | null> {
  const actorUserId = args.actorUserId.trim();
  const workNumberOwnerId = args.workNumberOwnerId.trim();
  if (!actorUserId || !workNumberOwnerId) return null;

  if (actorUserId === workNumberOwnerId) {
    const linked = await loadIncomingAssignedProperties(db, actorUserId);
    if (linked.propertyIds.length === 0) {
      return {
        mode: "owner",
        workNumberOwnerId,
        actorUserId,
        dataOwnerIds: [actorUserId],
        assignedPropertyIds: [],
      };
    }
    return {
      mode: "combined",
      workNumberOwnerId,
      actorUserId,
      dataOwnerIds: [actorUserId, ...linked.ownerIds.filter((id) => id !== actorUserId)],
      assignedPropertyIds: linked.propertyIds,
    };
  }

  const delegated = await loadIncomingAssignedProperties(db, actorUserId, workNumberOwnerId);
  if (delegated.propertyIds.length === 0) return null;
  return {
    mode: "delegated",
    workNumberOwnerId,
    actorUserId,
    dataOwnerIds: [workNumberOwnerId],
    assignedPropertyIds: delegated.propertyIds,
  };
}

export type ManagerSmsInboundIdentity = {
  workNumberOwnerId: string;
  actorUserId: string;
  workNumber: string;
  actorPhone: string;
  access: ManagerSmsAccess;
};

/**
 * Identity gate for the manager SMS assistant. `To` pins the work-number
 * owner. `From` must be that owner's verified cell, or a verified co-manager
 * cell with a current accepted assignment from that owner.
 *
 * Candidates are taken from THIS owner's invitees, never a global phone
 * search, so a random verified manager cannot hop onto someone else's number.
 */
export async function resolveManagerSmsInboundIdentity(
  db: SupabaseClient,
  args: { workNumberOwnerId: string; fromPhone: string; toPhone: string },
): Promise<ManagerSmsInboundIdentity | null> {
  const workNumberOwnerId = args.workNumberOwnerId.trim();
  if (!workNumberOwnerId) return null;
  const workNumber = normalizeE164(args.toPhone) ?? args.toPhone;

  const self = await detectManagerSelfReply(db, {
    managerUserId: workNumberOwnerId,
    fromPhone: args.fromPhone,
    toPhone: args.toPhone,
  });
  if (self) {
    const access = await resolveManagerSmsAccess(db, {
      actorUserId: self.managerUserId,
      workNumberOwnerId,
    });
    if (!access) return null;
    return {
      workNumberOwnerId,
      actorUserId: self.managerUserId,
      workNumber: self.workNumber,
      actorPhone: self.managerPhone,
      access,
    };
  }

  const { data: inviteRows, error: inviteError } = await db
    .from("account_link_invites")
    .select("invitee_user_id")
    .eq("status", "accepted")
    .eq("inviter_user_id", workNumberOwnerId);
  if (inviteError) return null;
  const inviteeIds = [
    ...new Set(
      (inviteRows ?? [])
        .map((row) => String((row as { invitee_user_id?: string }).invitee_user_id ?? "").trim())
        .filter((id) => id && id !== workNumberOwnerId),
    ),
  ];
  if (inviteeIds.length === 0) return null;

  const { data: profiles, error: profileError } = await db
    .from("profiles")
    .select("id, phone, phone_verified_at")
    .in("id", inviteeIds);
  if (profileError) return null;

  const matches = (profiles ?? []).filter((row) => {
    if (!row.phone_verified_at) return false;
    return samePhone(String(row.phone ?? ""), args.fromPhone);
  });
  if (matches.length !== 1) return null;
  const actorUserId = String(matches[0]?.id ?? "").trim();
  if (!actorUserId) return null;

  const access = await resolveManagerSmsAccess(db, { actorUserId, workNumberOwnerId });
  if (!access || access.mode !== "delegated") return null;
  return {
    workNumberOwnerId,
    actorUserId,
    workNumber,
    actorPhone: String(matches[0]?.phone ?? "").trim() || args.fromPhone,
    access,
  };
}

/**
 * Owner ids whose inbox this SMS turn may read or edit. Portal turns stay
 * actor-only. SMS turns intersect Communication grants with the number's data
 * owners so an assignment without inbox cannot dump the owner's threads.
 */
export async function smsInboxOwnerIds(
  ctx: AgentContext,
  level: "read" | "edit" | "delete" = "read",
): Promise<string[]> {
  if (!ctx.managerSmsAccess) return [ctx.userId];
  const granted = await viewerAndLinkedOwnerIdsForModule(
    ctx.db as Parameters<typeof viewerAndLinkedOwnerIdsForModule>[0],
    ctx.userId,
    "inbox",
    level,
  );
  return filterSmsInboxOwnerIds(ctx, granted);
}
