import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadWorkspaceHouse } from "@/lib/house-chat/access.server";
import { createConversationsGateway, ConversationsError } from "@/lib/house-groups/conversations-gateway.server";
import { loadHouseResidentCandidates } from "@/lib/house-groups/residents.server";
import { loadActiveGroup, loadSettings, workspaceOwner } from "@/lib/house-groups/store.server";
import { pacificDayKey } from "@/lib/house-groups/time";
import type { ConversationsGateway } from "@/lib/house-groups/types";
import { normalizeE164 } from "@/lib/phone-e164";
import { isPhoneOptedOut, normalizeConsentPhone } from "@/lib/sms-consent";
import { resolveSmsGroupLine, type SmsGroupLine } from "./line.server";
import {
  emptySmsGroupState,
  memberSetKey,
  planMembership,
  selectResidentMembers,
  SMS_GROUP_MIN_PHONES,
  type GroupResidentCandidate,
  type SmsGroupMember,
  type SmsGroupState,
} from "./model";
import { postToHouseSmsGroup, type SmsGroupPostDeps } from "./post.server";
import { ensureHouseThread, listWorkspaceSmsGroups, loadHouseSmsGroup, saveSmsGroupState, threadIdFor } from "./store.server";

export type StaffInput = { phoneE164: string; firstName: string; userId?: string | null };

export type SmsGroupSyncInput = {
  workspaceId: string;
  propertyId: string;
  /** Create the group record for a house that has none. Without it a house with no record is left alone. */
  enable?: boolean;
  addStaff?: readonly StaffInput[];
  /** Phone keys of staff to drop, and of residents a manager removed on purpose. */
  removePhoneKeys?: readonly string[];
};

export type SmsGroupSyncOutcome =
  | "no_group"
  | "not_found"
  | "no_line"
  | "pending"
  | "created"
  | "updated"
  | "unchanged"
  | "closed"
  | "duplicate_member_set"
  | "w10_group_active"
  | "shielded"
  | "error";

export type SmsGroupSyncResult = {
  propertyId: string;
  outcome: SmsGroupSyncOutcome;
  phones: number;
  /** Eligible phones past the nine seats. */
  overflow: number;
  detail?: string;
};

export type SmsGroupSyncDeps = {
  gateway?: ConversationsGateway | null;
  now?: () => Date;
  line?: (workspaceId: string, ownerUserId: string) => Promise<SmsGroupLine>;
  loadCandidates?: (propertyId: string) => Promise<GroupResidentCandidate[]>;
  isStopped?: (phoneE164: string, userId: string | null) => Promise<boolean>;
  shielded?: (phoneE164: string) => Promise<boolean>;
  post?: SmsGroupPostDeps;
};

/** Twilio's own message for the refusals a manager can act on; everything else is a plain failure. */
export function twilioGroupErrorText(code: string | undefined): string {
  switch (code) {
    case "50435":
      return "Twilio needs at least two phones plus the line before a group text can start.";
    case "50438":
    case "50416":
    case "50437":
      return "Twilio already has a group with exactly these phones on this line.";
    case "50452":
      return "Group MMS is not enabled on this Twilio account.";
    case "50439":
      return "This Twilio account may not use that number as the group line.";
    default:
      return "Twilio refused the group change.";
  }
}

function welcomeLine(newcomers: readonly SmsGroupMember[]): string {
  const names = newcomers.map((m) => m.firstName.trim() || "a housemate");
  const joined = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `Welcome ${joined}. Text LEAVE GROUP to opt out.`;
}

function introLine(label: string, members: readonly SmsGroupMember[]): string {
  const names = members.map((m) => m.firstName.trim() || "Team").join(", ");
  return `This is the ${label} house text. In it: ${names}. What you text here also shows in your PropLane house chat. Text LEAVE GROUP to opt out.`;
}

async function defaultCandidates(
  db: SupabaseClient,
  input: { ownerUserId: string; workspaceId: string; propertyId: string },
): Promise<GroupResidentCandidate[]> {
  return loadHouseResidentCandidates(db, { ...input, today: pacificDayKey(new Date()) });
}

/**
 * Make a house's SMS group match who belongs in it: its explicit staff plus the residents re-derived from
 * the Bookings occupancy snapshot (current long-term residents with a verified phone who have not left the
 * group and have not texted STOP). Idempotent: it compares who SHOULD be in with who IS and does nothing
 * when they match. A house that has no group record is left alone unless `enable` says to give it one.
 *
 *   - fewer than two phones: `pending`. The members are remembered; no Conversation exists (Twilio
 *     activates a group only with two phones plus the line), and one that existed is closed;
 *   - two or more: the Conversation is made (or its people added / removed in place) and the line joins
 *     last. A different line than the stored one rebuilds it. An identical phone set already live on
 *     another house of the workspace is refused (`duplicate_member_set`) before Twilio's 50438.
 *   - a protected account's phone outside production is `shielded`: nothing is created.
 * The Conversation SID, the line and the member list are stored on the house chat row.
 */
export async function syncHouseSmsGroup(
  db: SupabaseClient,
  input: SmsGroupSyncInput,
  deps: SmsGroupSyncDeps = {},
): Promise<SmsGroupSyncResult> {
  const { workspaceId, propertyId } = input;
  const result = (outcome: SmsGroupSyncOutcome, phones = 0, overflow = 0, detail?: string): SmsGroupSyncResult => ({
    propertyId,
    outcome,
    phones,
    overflow,
    ...(detail ? { detail } : {}),
  });
  const now = (deps.now ?? (() => new Date()))();

  const ownerUserId = await workspaceOwner(db, workspaceId);
  if (!ownerUserId) return result("not_found");
  const house = await loadWorkspaceHouse(db, { workspaceId, ownerUserId, propertyId });
  if (!house) return result("not_found");

  const threadId = threadIdFor({ ownerUserId, workspaceId, propertyId });
  const existing = await loadHouseSmsGroup(db, threadId);
  if (!existing?.state && !input.enable) return result("no_group");
  const current = existing?.state ?? emptySmsGroupState(now);

  const lineResult = deps.line ? await deps.line(workspaceId, ownerUserId) : await resolveSmsGroupLine(db, { workspaceId, ownerUserId });
  if (!lineResult.ok) return result("no_line", 0, 0, lineResult.reason);
  const line = lineResult.line;

  // The W10 RA group and this one never both serve a house: two Conversations on one phone set is Twilio's 50438.
  const w10 = (await loadSettings(db, workspaceId)).enabled ? await loadActiveGroup(db, propertyId) : null;
  if (w10) return result("w10_group_active");

  const ensured = await ensureHouseThread(db, { ownerUserId, workspaceId, propertyId, houseLabel: house.label });
  if (!ensured) return result("error", 0, 0, "house_chat_unavailable");

  // Staff: the stored ones, plus the new, minus the removed.
  const removeKeys = new Set((input.removePhoneKeys ?? []).map((k) => normalizeConsentPhone(k)));
  const staffByKey = new Map<string, SmsGroupMember>();
  for (const m of current.members) if (m.kind === "staff" && !removeKeys.has(m.phoneKey)) staffByKey.set(m.phoneKey, m);
  for (const s of input.addStaff ?? []) {
    const e164 = normalizeE164(s.phoneE164);
    if (!e164) continue;
    const phoneKey = normalizeConsentPhone(e164);
    if (staffByKey.has(phoneKey)) continue;
    staffByKey.set(phoneKey, {
      phoneKey,
      phoneE164: e164,
      kind: "staff",
      firstName: s.firstName.trim().split(/\s+/)[0]?.slice(0, 40) ?? "",
      roomLabel: "",
      userId: s.userId ?? null,
      participantSid: null,
      addedAt: now.toISOString(),
    });
  }
  // A phone a manager removed that belongs to a resident stays out; an explicit staff add brings it back.
  const addedKeys = new Set((input.addStaff ?? []).map((s) => normalizeConsentPhone(s.phoneE164)));
  const excluded = new Set(current.excludedPhoneKeys.filter((k) => !addedKeys.has(k)));
  for (const k of removeKeys) if (current.members.find((m) => m.phoneKey === k)?.kind === "resident") excluded.add(k);

  let candidates: GroupResidentCandidate[];
  try {
    candidates = deps.loadCandidates ? await deps.loadCandidates(propertyId) : await defaultCandidates(db, { ownerUserId, workspaceId, propertyId });
  } catch {
    return result("error", 0, 0, "occupancy_unreadable");
  }
  const picked = selectResidentMembers(candidates, [...excluded], new Set(staffByKey.keys()));

  const isStopped =
    deps.isStopped ?? ((phone: string, userId: string | null) => isPhoneOptedOut(db, phone, { userId }).catch(() => false));
  const stopped = new Set<string>();
  for (const s of staffByKey.values()) if (await isStopped(s.phoneE164, s.userId)) stopped.add(s.phoneKey);

  const plan = planMembership({
    current: current.members,
    staff: [...staffByKey.values()],
    residents: picked.members,
    stoppedPhoneKeys: stopped,
    now,
  });
  const desiredKeys = plan.desired.map((m) => m.phoneKey);
  const phones = plan.desired.length;

  const save = (state: Partial<SmsGroupState> & Pick<SmsGroupState, "members">) =>
    saveSmsGroupState(db, ensured, (cur) => ({ ...(cur ?? emptySmsGroupState(now)), excludedPhoneKeys: [...excluded], line, ...state, updatedAt: now.toISOString() }));

  const gatewayFor = () => (deps.gateway === undefined ? createConversationsGateway() : deps.gateway);

  // ---- fewer than two phones: no Conversation ----
  if (phones < SMS_GROUP_MIN_PHONES) {
    if (current.conversationSid) {
      const gateway = gatewayFor();
      if (!gateway) return result("error", phones, plan.overflow, "twilio_not_configured");
      try {
        await gateway.closeConversation(current.conversationSid);
      } catch (error) {
        return result("error", phones, plan.overflow, twilioGroupErrorText(error instanceof ConversationsError ? error.code : undefined));
      }
      await save({ members: plan.desired.map((m) => ({ ...m, participantSid: null })), status: "pending", conversationSid: null });
      return result("closed", phones, plan.overflow);
    }
    const unchangedPending = Boolean(existing?.state) && current.status === "pending" && sameKeys(current.members, desiredKeys) && current.line === line;
    if (!unchangedPending) await save({ members: plan.desired, status: "pending", conversationSid: null });
    return result("pending", phones, plan.overflow);
  }

  // ---- two or more phones ----
  const unchanged =
    current.status === "active" &&
    current.conversationSid &&
    current.line === line &&
    plan.added.length === 0 &&
    plan.removed.length === 0 &&
    current.members.every((m) => m.participantSid);
  if (unchanged) return result("unchanged", phones, plan.overflow);

  const key = memberSetKey(line, desiredKeys);
  const others = await listWorkspaceSmsGroups(db, workspaceId);
  const clash = others.find(
    (o) => o.propertyId !== propertyId && o.state.status === "active" && memberSetKey(o.state.line, o.state.members.map((m) => m.phoneKey)) === key,
  );
  if (clash) {
    await save({ members: plan.desired, status: current.status });
    return result("duplicate_member_set", phones, plan.overflow);
  }

  const shielded = deps.shielded ?? (async (phone: string) => (await import("@/lib/protected-accounts.server")).isShieldedRecipient({ phone }));
  for (const m of plan.desired) {
    if (await shielded(m.phoneE164)) {
      await save({ members: plan.desired, status: current.status });
      return result("shielded", phones, plan.overflow);
    }
  }

  const gateway = gatewayFor();
  if (!gateway) return result("error", phones, plan.overflow, "twilio_not_configured");

  const rebuild = current.status !== "active" || !current.conversationSid || (current.line !== null && current.line !== line);
  let conversationSid = current.conversationSid;
  const members: SmsGroupMember[] = plan.desired.map((m) => ({ ...m, participantSid: rebuild ? null : m.participantSid }));
  let phase: "create" | "update" = "update";
  try {
    if (rebuild) {
      phase = "create";
      if (current.conversationSid) await gateway.closeConversation(current.conversationSid).catch(() => undefined);
      const conversation = await gateway.createConversation({ friendlyName: `House ${house.label}`.slice(0, 120) });
      conversationSid = conversation.sid;
      await gateway.watchConversation(conversation.sid);
      for (const m of members) m.participantSid = (await gateway.addResident(conversation.sid, m.phoneE164)).participantSid;
      // The line joins last: the Conversation reaches three participants only now.
      await gateway.addProplane(conversation.sid, line);
    } else {
      if (!gateway.removeParticipant) return result("error", phones, plan.overflow, "gateway_cannot_remove");
      for (const gone of plan.removed) {
        if (gone.participantSid && conversationSid) await gateway.removeParticipant(conversationSid, gone.participantSid);
      }
      for (const m of members) {
        if (!m.participantSid && conversationSid) m.participantSid = (await gateway.addResident(conversationSid, m.phoneE164)).participantSid;
      }
    }
  } catch (error) {
    const code = error instanceof ConversationsError ? error.code : undefined;
    console.error("house sms group sync failed", phase, code ?? "unknown");
    if (phase === "create" && conversationSid) await gateway.closeConversation(conversationSid).catch(() => undefined);
    await save({ members: plan.desired.map((m) => ({ ...m, participantSid: null })), status: "pending", conversationSid: null });
    return result("error", phones, plan.overflow, twilioGroupErrorText(code));
  }

  await save({ members, status: "active", conversationSid, line });

  // Say hello: the intro once, a welcome for each later newcomer. Never at night (the next sync does it).
  const introKey = `sms-group-intro:${conversationSid}`;
  const posted = rebuild
    ? await postToHouseSmsGroup(db, { workspaceId, propertyId, ownerUserId, text: introLine(house.label, members), kind: "intro", idempotencyKey: introKey }, { gateway, now: deps.now, ...deps.post }).catch(() => null)
    : plan.added.length > 0
      ? await postToHouseSmsGroup(
          db,
          { workspaceId, propertyId, ownerUserId, text: welcomeLine(plan.added), kind: "welcome", idempotencyKey: `sms-group-welcome:${conversationSid}:${plan.added.map((m) => m.phoneKey).sort().join(",")}` },
          { gateway, now: deps.now, ...deps.post },
        ).catch(() => null)
      : null;
  if (rebuild && posted?.ok) await saveSmsGroupState(db, ensured, (cur) => (cur ? { ...cur, introPostedAt: now.toISOString() } : null));
  return result(rebuild ? "created" : "updated", phones, plan.overflow);
}

function sameKeys(members: readonly SmsGroupMember[], keys: readonly string[]): boolean {
  const a = [...members.map((m) => m.phoneKey)].sort().join(",");
  return a === [...keys].sort().join(",");
}

/**
 * A resident was just onboarded (or moved in): add them to their house's group when the house has one.
 * Fire-and-forget safe: never throws, and does nothing for a house that has no group record.
 */
export async function addResidentToHouseSmsGroup(
  db: SupabaseClient,
  input: { workspaceId: string; propertyId: string },
  deps: SmsGroupSyncDeps = {},
): Promise<SmsGroupSyncResult | null> {
  try {
    return await syncHouseSmsGroup(db, { workspaceId: input.workspaceId, propertyId: input.propertyId }, deps);
  } catch {
    return null;
  }
}

/** The daily batch for one workspace: every house that has a group record. Also removes STOPped, moved-out and left phones. */
export async function syncWorkspaceSmsGroups(db: SupabaseClient, workspaceId: string, deps: SmsGroupSyncDeps = {}): Promise<SmsGroupSyncResult[]> {
  const groups = await listWorkspaceSmsGroups(db, workspaceId);
  const out: SmsGroupSyncResult[] = [];
  for (const g of groups) {
    try {
      out.push(await syncHouseSmsGroup(db, { workspaceId, propertyId: g.propertyId }, deps));
    } catch {
      out.push({ propertyId: g.propertyId, outcome: "error", phones: 0, overflow: 0 });
    }
  }
  return out;
}

/** The daily sweep: every workspace that has at least one house with a group record. */
export async function syncAllHouseSmsGroups(db: SupabaseClient, deps: SmsGroupSyncDeps = {}): Promise<{ workspaces: number; houses: number; errors: number }> {
  const total = { workspaces: 0, houses: 0, errors: 0 };
  let ids: string[] = [];
  try {
    const { data } = await db
      .from("portal_inbox_thread_records")
      .select("workspace_id")
      .eq("thread_type", "house")
      .not("row_data->smsGroup->>version", "is", null)
      .limit(1000);
    ids = [...new Set(((data ?? []) as Array<{ workspace_id?: unknown }>).map((r) => String(r.workspace_id ?? "").trim()).filter(Boolean))];
  } catch {
    return total;
  }
  for (const workspaceId of ids) {
    const results = await syncWorkspaceSmsGroups(db, workspaceId, deps);
    total.workspaces += 1;
    total.houses += results.length;
    total.errors += results.filter((r) => r.outcome === "error").length;
  }
  return total;
}
