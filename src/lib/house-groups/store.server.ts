import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingSchemaError } from "@/lib/one-number/config.server";
import { DEFAULT_MAX_POSTS_PER_DAY, type GroupMember } from "./types";
import { pacificDayStart } from "./time";

/**
 * Every read and write of the house-group tables. A missing table or column (code running before
 * its migration) reads as "nothing there", exactly like every other one-number table, so a
 * workspace that never turned groups on is never affected.
 */

type Row = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());

export type GroupStatus = "active" | "retired" | "closed";

export type GroupRow = {
  id: string;
  workspaceId: string;
  propertyId: string;
  conversationSid: string;
  status: GroupStatus;
  memberHash: string;
  retiredNoticeSentAt: string | null;
  createdAt: string;
  retiredAt: string | null;
};

export type MemberRow = GroupMember & { id: string; participantSid: string | null; joinedAt: string };

export type HouseGroupSettings = { enabled: boolean; maxPostsPerDay: number };
export const DEFAULT_SETTINGS: HouseGroupSettings = { enabled: false, maxPostsPerDay: DEFAULT_MAX_POSTS_PER_DAY };

function toGroup(r: Row): GroupRow {
  return {
    id: str(r.id),
    workspaceId: str(r.workspace_id),
    propertyId: str(r.property_id),
    conversationSid: str(r.conversation_sid),
    status: (str(r.status) as GroupStatus) || "active",
    memberHash: str(r.member_hash),
    retiredNoticeSentAt: str(r.retired_notice_sent_at) || null,
    createdAt: str(r.created_at),
    retiredAt: str(r.retired_at) || null,
  };
}

async function rows(q: PromiseLike<{ data: unknown; error: { code?: string | null } | null }>): Promise<Row[]> {
  try {
    const { data, error } = await q;
    if (error) return [];
    return Array.isArray(data) ? (data as Row[]) : [];
  } catch {
    return [];
  }
}

export async function loadSettings(db: SupabaseClient, workspaceId: string): Promise<HouseGroupSettings> {
  const [r] = await rows(db.from("house_group_settings").select("enabled, max_posts_per_day").eq("workspace_id", workspaceId).limit(1));
  if (!r) return DEFAULT_SETTINGS;
  const max = Number(r.max_posts_per_day);
  return { enabled: r.enabled === true, maxPostsPerDay: Number.isFinite(max) && max >= 1 ? Math.min(12, Math.floor(max)) : DEFAULT_MAX_POSTS_PER_DAY };
}

export async function saveSettings(
  db: SupabaseClient,
  workspaceId: string,
  userId: string,
  patch: Partial<HouseGroupSettings>,
): Promise<{ ok: true; settings: HouseGroupSettings } | { ok: false }> {
  const current = await loadSettings(db, workspaceId);
  const next: HouseGroupSettings = {
    enabled: patch.enabled ?? current.enabled,
    maxPostsPerDay: Math.min(12, Math.max(1, Math.floor(patch.maxPostsPerDay ?? current.maxPostsPerDay))),
  };
  try {
    const { error } = await db.from("house_group_settings").upsert(
      { workspace_id: workspaceId, enabled: next.enabled, max_posts_per_day: next.maxPostsPerDay, updated_by: userId, updated_at: new Date().toISOString() },
      { onConflict: "workspace_id" },
    );
    return error ? { ok: false } : { ok: true, settings: next };
  } catch {
    return { ok: false };
  }
}

export async function loadActiveGroup(db: SupabaseClient, propertyId: string): Promise<GroupRow | null> {
  const [r] = await rows(db.from("house_group_conversations").select("*").eq("property_id", propertyId).eq("status", "active").limit(1));
  return r ? toGroup(r) : null;
}

export async function loadGroupBySid(db: SupabaseClient, conversationSid: string): Promise<GroupRow | null> {
  const [r] = await rows(db.from("house_group_conversations").select("*").eq("conversation_sid", conversationSid).limit(1));
  return r ? toGroup(r) : null;
}

export async function loadGroupById(db: SupabaseClient, id: string): Promise<GroupRow | null> {
  const [r] = await rows(db.from("house_group_conversations").select("*").eq("id", id).limit(1));
  return r ? toGroup(r) : null;
}

export async function loadGroupsWithStatus(db: SupabaseClient, statuses: GroupStatus[], workspaceId?: string): Promise<GroupRow[]> {
  let q = db.from("house_group_conversations").select("*").in("status", statuses);
  if (workspaceId) q = q.eq("workspace_id", workspaceId);
  return (await rows(q.limit(1000))).map(toGroup);
}

export async function findGroupByHash(
  db: SupabaseClient,
  propertyId: string,
  memberHash: string,
  statuses: GroupStatus[] = ["active", "retired"],
): Promise<GroupRow | null> {
  const [r] = await rows(
    db.from("house_group_conversations").select("*").eq("property_id", propertyId).eq("member_hash", memberHash).in("status", statuses).limit(1),
  );
  return r ? toGroup(r) : null;
}

export async function insertGroup(
  db: SupabaseClient,
  input: { workspaceId: string; propertyId: string; conversationSid: string; memberHash: string },
): Promise<GroupRow | null> {
  try {
    const { data, error } = await db
      .from("house_group_conversations")
      .insert({
        workspace_id: input.workspaceId,
        property_id: input.propertyId,
        conversation_sid: input.conversationSid,
        member_hash: input.memberHash,
        status: "active",
      })
      .select("*")
      .maybeSingle();
    return error || !data ? null : toGroup(data as Row);
  } catch {
    return null;
  }
}

export async function setGroupStatus(
  db: SupabaseClient,
  id: string,
  status: GroupStatus,
  extra: { supersededBy?: string | null } = {},
): Promise<boolean> {
  const now = new Date().toISOString();
  const patch: Row = { status };
  if (status === "retired") {
    patch.retired_at = now;
    if (extra.supersededBy !== undefined) patch.superseded_by = extra.supersededBy;
  }
  if (status === "active") {
    patch.retired_at = null;
    patch.retired_notice_sent_at = null;
    patch.superseded_by = null;
  }
  if (status === "closed") patch.closed_at = now;
  try {
    const { error } = await db.from("house_group_conversations").update(patch).eq("id", id);
    return !error;
  } catch {
    return false;
  }
}

export async function markRetiredNoticeSent(db: SupabaseClient, id: string): Promise<boolean> {
  try {
    // Compare-and-set: only the first stray text sends the notice.
    const { data, error } = await db
      .from("house_group_conversations")
      .update({ retired_notice_sent_at: new Date().toISOString() })
      .eq("id", id)
      .is("retired_notice_sent_at", null)
      .select("id");
    return !error && Array.isArray(data) && data.length > 0;
  } catch {
    return false;
  }
}

function toMember(r: Row): MemberRow {
  return {
    id: str(r.id),
    phoneKey: str(r.phone_key),
    phoneE164: str(r.phone_e164),
    userId: str(r.resident_user_id) || null,
    firstName: str(r.first_name),
    roomLabel: str(r.room_label),
    moveIn: null,
    participantSid: str(r.participant_sid) || null,
    joinedAt: str(r.joined_at),
  };
}

export async function loadMembers(db: SupabaseClient, groupId: string): Promise<MemberRow[]> {
  return (await rows(db.from("house_group_members").select("*").eq("group_id", groupId).is("left_at", null).limit(50))).map(toMember);
}

export async function insertMembers(
  db: SupabaseClient,
  groupId: string,
  members: readonly (GroupMember & { participantSid?: string | null })[],
): Promise<boolean> {
  if (members.length === 0) return true;
  try {
    const { error } = await db.from("house_group_members").upsert(
      members.map((m) => ({
        group_id: groupId,
        phone_key: m.phoneKey,
        phone_e164: m.phoneE164,
        resident_user_id: m.userId,
        first_name: m.firstName.slice(0, 40),
        room_label: m.roomLabel.slice(0, 60),
        participant_sid: m.participantSid ?? null,
        left_at: null,
      })),
      { onConflict: "group_id,phone_key" },
    );
    return !error;
  } catch {
    return false;
  }
}

/** Is this phone a current member of an ACTIVE or RETIRED group? Returns every such group. */
export async function loadMembershipsForPhone(db: SupabaseClient, phoneKey: string): Promise<{ member: MemberRow; group: GroupRow }[]> {
  const memberRows = await rows(db.from("house_group_members").select("*").eq("phone_key", phoneKey).is("left_at", null).limit(20));
  const out: { member: MemberRow; group: GroupRow }[] = [];
  for (const r of memberRows) {
    const group = await loadGroupById(db, str(r.group_id));
    if (group && group.status !== "closed") out.push({ member: toMember(r), group });
  }
  return out;
}

export type PreferenceRow = { phoneKey: string; optedOut: boolean; consentAt: string | null };

export async function loadPreferences(db: SupabaseClient, workspaceId: string, phoneKeys: readonly string[]): Promise<Map<string, PreferenceRow>> {
  if (phoneKeys.length === 0) return new Map();
  const data = await rows(
    db.from("house_group_preferences").select("phone_key, opted_out_of_group, consent_at").eq("workspace_id", workspaceId).in("phone_key", [...phoneKeys]),
  );
  return new Map(
    data.map((r) => [str(r.phone_key), { phoneKey: str(r.phone_key), optedOut: r.opted_out_of_group === true, consentAt: str(r.consent_at) || null }] as const),
  );
}

export async function recordConsent(
  db: SupabaseClient,
  workspaceId: string,
  phoneKey: string,
  source: "lease_signature" | "sms_join" | "manager_record",
): Promise<boolean> {
  try {
    const { error } = await db.from("house_group_preferences").upsert(
      { workspace_id: workspaceId, phone_key: phoneKey, opted_out_of_group: false, consent_at: new Date().toISOString(), consent_source: source, updated_at: new Date().toISOString() },
      { onConflict: "workspace_id,phone_key" },
    );
    return !error;
  } catch {
    return false;
  }
}

export async function recordOptOut(db: SupabaseClient, workspaceId: string, phoneKey: string): Promise<boolean> {
  try {
    const { error } = await db.from("house_group_preferences").upsert(
      { workspace_id: workspaceId, phone_key: phoneKey, opted_out_of_group: true, updated_at: new Date().toISOString() },
      { onConflict: "workspace_id,phone_key" },
    );
    return !error;
  } catch {
    return false;
  }
}

export type MessageInsert = {
  groupId: string;
  workspaceId: string;
  propertyId: string;
  direction: "inbound" | "outbound";
  kind: string;
  authorPhoneKey?: string | null;
  messageSid?: string | null;
  idempotencyKey?: string | null;
  body: string;
  flag?: string | null;
  answerCheckAt?: string | null;
};

/** `duplicate` = the (group, sid) or (group, key) is already logged. */
export async function insertMessage(db: SupabaseClient, m: MessageInsert): Promise<{ ok: true; id: string } | { ok: false; duplicate: boolean }> {
  try {
    const { data, error } = await db
      .from("house_group_messages")
      .insert({
        group_id: m.groupId,
        workspace_id: m.workspaceId,
        property_id: m.propertyId,
        direction: m.direction,
        kind: m.kind,
        author_phone_key: m.authorPhoneKey ?? null,
        message_sid: m.messageSid ?? null,
        idempotency_key: m.idempotencyKey ?? null,
        body: m.body.slice(0, 600),
        flag: m.flag ?? null,
        answer_check_at: m.answerCheckAt ?? null,
      })
      .select("id")
      .maybeSingle();
    if (error) return { ok: false, duplicate: String(error.code) === "23505" };
    return data ? { ok: true, id: str((data as Row).id) } : { ok: false, duplicate: false };
  } catch {
    return { ok: false, duplicate: false };
  }
}

export async function loadMessageByKey(db: SupabaseClient, groupId: string, idempotencyKey: string): Promise<{ id: string; messageSid: string | null } | null> {
  const [r] = await rows(db.from("house_group_messages").select("id, message_sid").eq("group_id", groupId).eq("idempotency_key", idempotencyKey).limit(1));
  return r ? { id: str(r.id), messageSid: str(r.message_sid) || null } : null;
}

export async function setMessageSid(db: SupabaseClient, id: string, messageSid: string): Promise<void> {
  try {
    await db.from("house_group_messages").update({ message_sid: messageSid }).eq("id", id);
  } catch {
    /* the row still dedupes by key */
  }
}

export async function deleteMessage(db: SupabaseClient, id: string): Promise<void> {
  try {
    await db.from("house_group_messages").delete().eq("id", id);
  } catch {
    /* ignore */
  }
}

/** Kinds that never count toward the daily cap: a human's announcement, an emergency, the intro. */
export const CAP_EXEMPT_KINDS: readonly string[] = ["announcement", "emergency", "intro"];

export async function countCappedPostsToday(db: SupabaseClient, groupId: string, now: Date): Promise<number> {
  const since = pacificDayStart(now).toISOString();
  const data = await rows(
    db.from("house_group_messages").select("id, kind").eq("group_id", groupId).eq("direction", "outbound").gte("created_at", since).limit(200),
  );
  return data.filter((r) => !CAP_EXEMPT_KINDS.includes(str(r.kind))).length;
}

export async function countRecentFlags(db: SupabaseClient, groupId: string, flag: string, sinceIso: string): Promise<number> {
  const data = await rows(
    db.from("house_group_messages").select("id").eq("group_id", groupId).eq("direction", "inbound").eq("flag", flag).gte("created_at", sinceIso).limit(50),
  );
  return data.length;
}

export async function hasInboundAfter(db: SupabaseClient, groupId: string, afterIso: string, excludeId: string): Promise<boolean> {
  const data = await rows(
    db.from("house_group_messages").select("id").eq("group_id", groupId).eq("direction", "inbound").gt("created_at", afterIso).limit(5),
  );
  return data.some((r) => str(r.id) !== excludeId);
}

export type DueCheck = { id: string; groupId: string; workspaceId: string; propertyId: string; body: string; flag: string | null; authorPhoneKey: string | null; createdAt: string };

export async function loadDueChecks(db: SupabaseClient, nowIso: string, limit = 50): Promise<DueCheck[]> {
  const data = await rows(
    db
      .from("house_group_messages")
      .select("id, group_id, workspace_id, property_id, body, flag, author_phone_key, created_at, answer_check_at, answered_at")
      .is("answered_at", null)
      .not("answer_check_at", "is", null)
      .lte("answer_check_at", nowIso)
      .order("answer_check_at", { ascending: true })
      .limit(limit),
  );
  return data.map((r) => ({
    id: str(r.id),
    groupId: str(r.group_id),
    workspaceId: str(r.workspace_id),
    propertyId: str(r.property_id),
    body: str(r.body),
    flag: str(r.flag) || null,
    authorPhoneKey: str(r.author_phone_key) || null,
    createdAt: str(r.created_at),
  }));
}

export async function resolveCheck(db: SupabaseClient, id: string, nextCheckAt: string | null): Promise<void> {
  try {
    await db
      .from("house_group_messages")
      .update(nextCheckAt ? { answer_check_at: nextCheckAt } : { answered_at: new Date().toISOString(), answer_check_at: null })
      .eq("id", id);
  } catch {
    /* the next sweep retries */
  }
}

export async function workspaceOwner(db: SupabaseClient, workspaceId: string): Promise<string | null> {
  const [r] = await rows(db.from("portal_workspaces").select("owner_user_id").eq("id", workspaceId).limit(1));
  return r ? str(r.owner_user_id) || null : null;
}

export { isMissingSchemaError };
