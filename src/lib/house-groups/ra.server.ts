import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { EMERGENCY_SAFETY_REPLY } from "@/lib/one-number/contracts";
import { redactSensitiveNumbers } from "@/lib/one-number/redact";
import { loadSharedLineConfig, workspaceOnSharedLine } from "@/lib/one-number/config.server";
import { alertWorkspaceTeam } from "@/lib/one-number/team-alerts.server";
import { recordEscalationItem, recordHouseComplaint } from "@/lib/automations/escalations.server";
import { normalizeConsentPhone } from "@/lib/sms-consent";
import { normalizeE164 } from "@/lib/phone-e164";
import {
  COMPLAINT_ACK,
  JOIN_CONFIRM,
  JOIN_NEEDS_THREAD,
  LEAVE_CONFIRM,
  RETIRED_REPLY,
  RULES_REMINDER_GENERAL,
  RULES_REMINDER_NOISE,
  RULES_REMINDER_SPACES,
  UNKNOWN_FACT_REPLY,
} from "./copy";
import { composeFactReply, type LookupLike } from "./facts";
import { createConversationsGateway } from "./conversations-gateway.server";
import { sendComplaintFollowUp, syncHouseGroup, type SyncDeps } from "./manager.server";
import { postToHouseGroup, type PostDeps } from "./post.server";
import { classifyGroupText, planDueCheck, planGroupReply, RULE_WINDOW_MS, type RaPlan } from "./ra-policy";
import {
  countCappedPostsToday,
  countRecentFlags,
  hasInboundAfter,
  insertMessage,
  loadDueChecks,
  loadGroupById,
  loadGroupBySid,
  loadMembers,
  loadSettings,
  markRetiredNoticeSent,
  recordConsent,
  recordOptOut,
  resolveCheck,
  workspaceOwner,
  type GroupRow,
  type MemberRow,
} from "./store.server";
import { pacificDayKey } from "./time";
import { PROPLANE_IDENTITY, type ConversationsGateway } from "./types";

export type RaDeps = {
  gateway?: ConversationsGateway | null;
  now?: () => Date;
  alert?: typeof alertWorkspaceTeam;
  sendDirect?: SyncDeps["sendDirect"];
  /** House-fact lookup for this house, as a resident would be answered (W6's `lookupPropertyKnowledge`). */
  lookup?: (input: { workspaceId: string; ownerUserId: string; propertyId: string; question: string }) => Promise<LookupLike>;
  post?: PostDeps;
  sync?: SyncDeps;
};

/** The Conversations `onMessageAdded` fields the RA reads. */
export type GroupWebhookMessage = {
  conversationSid: string;
  messageSid: string;
  author: string;
  body: string;
  mediaCount: number;
};

export type GroupHandleResult =
  | { handled: false; reason: "unknown_group" | "own_message" | "not_enabled" | "not_a_member" | "duplicate" | "closed" | "empty" }
  | { handled: true; action: string };

async function defaultLookup(
  db: SupabaseClient,
  input: { workspaceId: string; ownerUserId: string; propertyId: string; question: string },
): Promise<LookupLike> {
  const { lookupPropertyKnowledge } = await import("@/lib/one-number/knowledge/lookup.server");
  return lookupPropertyKnowledge(
    db,
    {
      viewer: "resident",
      workspaceId: input.workspaceId,
      ownerUserId: input.ownerUserId,
      allowedPropertyIds: [input.propertyId],
      focusPropertyId: input.propertyId,
      audiences: ["all", "residents"],
      includeHouseInfo: true,
    },
    input.question,
  );
}

function excerpt(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

async function houseLabelOf(db: SupabaseClient, propertyId: string): Promise<string> {
  try {
    const { data } = await db.from("manager_property_records").select("row_data").eq("id", propertyId).maybeSingle();
    const { propertyLabel } = await import("@/lib/one-number/router-lookups.server");
    return propertyLabel((data as { row_data?: unknown } | null)?.row_data) || "the house";
  } catch {
    return "the house";
  }
}

type Ctx = {
  db: SupabaseClient;
  group: GroupRow;
  ownerUserId: string;
  deps: RaDeps;
  now: Date;
  gateway: ConversationsGateway | null;
};

function postDeps(c: Ctx): PostDeps {
  return { gateway: c.gateway, now: () => c.now, ...c.deps.post };
}

async function say(c: Ctx, text: string, kind: string, key: string) {
  return postToHouseGroup(
    c.db,
    { workspaceId: c.group.workspaceId, propertyId: c.group.propertyId, text, kind, idempotencyKey: key },
    postDeps(c),
  );
}

async function privateText(c: Ctx, member: Pick<MemberRow, "phoneE164">, body: string, key: string) {
  const send = c.deps.sendDirect;
  const input = { workspaceId: c.group.workspaceId, ownerUserId: c.ownerUserId, toPhone: member.phoneE164, body, idempotencyKey: key };
  if (send) return Promise.resolve(send(input)).catch(() => undefined);
  const { sendSharedLineMessage } = await import("@/lib/one-number/send.server");
  return sendSharedLineMessage(c.db, {
    workspaceId: input.workspaceId,
    ownerUserId: input.ownerUserId,
    toPhone: input.toPhone,
    body: input.body,
    role: "resident",
    idempotencyKey: key,
  }).catch(() => undefined);
}

async function tellTeam(c: Ctx, member: MemberRow | null, text: string, kind: "emergency" | "unanswered" | "human_request", urgent: boolean, key: string) {
  const alert = c.deps.alert ?? alertWorkspaceTeam;
  const who = member ? `${member.firstName || "A resident"}${member.roomLabel ? ` (${member.roomLabel})` : ""}: ` : "";
  await alert(c.db, {
    workspaceId: c.group.workspaceId,
    ownerUserId: c.ownerUserId,
    kind,
    urgent,
    propertyId: c.group.propertyId,
    text: `House chat · ${who}${text}`.slice(0, 480),
    idempotencyKey: key,
  }).catch(() => undefined);
}

/**
 * File what the RA handed to the team into the manager's escalations inbox (best effort: it never
 * breaks the conversation). A complaint is counted against the house's threshold; everything else
 * is one open item with the redacted excerpt.
 */
async function fileEscalation(
  c: Ctx,
  member: MemberRow,
  input: { kind: "complaint" | "item"; source: "ra" | "unanswered"; topic: string; text: string },
): Promise<void> {
  try {
    if (input.kind === "complaint") {
      let houseInfo = null;
      try {
        const { loadHouseDirectory } = await import("@/lib/automations/sources.server");
        houseInfo = (await loadHouseDirectory(c.db, [c.group.propertyId])).get(c.group.propertyId)?.houseInfo ?? null;
      } catch {
        houseInfo = null;
      }
      await recordHouseComplaint(c.db, {
        workspaceId: c.group.workspaceId,
        ownerUserId: c.ownerUserId,
        propertyId: c.group.propertyId,
        phone: member.phoneE164,
        text: input.text,
        houseInfo,
        now: c.now,
      });
      return;
    }
    await recordEscalationItem(c.db, {
      workspaceId: c.group.workspaceId,
      ownerUserId: c.ownerUserId,
      source: input.source,
      phone: member.phoneE164,
      propertyId: c.group.propertyId,
      topic: input.topic,
      question: input.text,
      excerpt: input.text,
      at: c.now,
    });
  } catch {
    /* the inbox is a convenience; the group keeps working */
  }
}

/** Answer a house-fact question into the group (or privately). Returns what was done. */
async function answerQuestion(c: Ctx, member: MemberRow, question: string, key: string, privately: boolean): Promise<string> {
  const lookup =
    c.deps.lookup ??
    ((input) => defaultLookup(c.db, input));
  let result: LookupLike;
  try {
    result = await lookup({ workspaceId: c.group.workspaceId, ownerUserId: c.ownerUserId, propertyId: c.group.propertyId, question });
  } catch {
    return "lookup_failed";
  }
  const reply = composeFactReply(result, member.firstName);
  if (reply.kind === "escalate") {
    await say(c, COMPLAINT_ACK, "complaint_ack", `${key}:ack`);
    await sendComplaintFollowUp(c.db, { workspaceId: c.group.workspaceId, ownerUserId: c.ownerUserId, phoneE164: member.phoneE164, firstName: member.firstName, idempotencyKey: `${key}:dm` }, c.deps.sendDirect);
    await tellTeam(c, member, `asked about something for the team: "${excerpt(question)}"`, "unanswered", false, `${key}:team`);
    await fileEscalation(c, member, { kind: "item", source: "ra", topic: "house_question", text: question });
    return "escalated";
  }
  if (reply.kind === "unknown") {
    if (privately) await privateText(c, member, UNKNOWN_FACT_REPLY, `${key}:dm`);
    else await say(c, UNKNOWN_FACT_REPLY, "answer", `${key}:answer`);
    await tellTeam(c, member, `asked "${excerpt(question)}" and no approved answer covers it`, "unanswered", false, `${key}:team`);
    await fileEscalation(c, member, { kind: "item", source: "unanswered", topic: "house_question", text: question });
    return "unknown_fact";
  }
  if (reply.kind === "private") {
    await privateText(c, member, reply.privateText, `${key}:secret`);
    if (!privately) await say(c, reply.groupText, "answer", `${key}:answer`);
    return "answered_private_secret";
  }
  if (privately) await privateText(c, member, reply.text, `${key}:dm`);
  else {
    const posted = await say(c, reply.text, "answer", `${key}:answer`);
    if (!posted.ok && posted.reason === "rate_limited") await privateText(c, member, reply.text, `${key}:dm`);
  }
  return "answered";
}

function reminderFor(plan: RaPlan, topic: ReturnType<typeof classifyGroupText>["ruleTopic"]): string {
  void plan;
  return topic === "noise" ? RULES_REMINDER_NOISE : topic === "spaces" ? RULES_REMINDER_SPACES : RULES_REMINDER_GENERAL;
}

/**
 * One new message in a house group (Conversations `onMessageAdded`, already signature-verified).
 * Idempotent on (group, MessageSid): a Twilio retry changes nothing. The RA is quiet by default;
 * see `ra-policy.ts` for when it speaks. Nobody is ever named or punished in the group.
 */
export async function handleGroupMessage(db: SupabaseClient, message: GroupWebhookMessage, deps: RaDeps = {}): Promise<GroupHandleResult> {
  const now = (deps.now ?? (() => new Date()))();
  const group = await loadGroupBySid(db, message.conversationSid.trim());
  if (!group) return { handled: false, reason: "unknown_group" };
  if (message.author.trim() === PROPLANE_IDENTITY) return { handled: false, reason: "own_message" };
  if (group.status === "closed") return { handled: false, reason: "closed" };

  const config = await loadSharedLineConfig(db);
  const settings = await loadSettings(db, group.workspaceId);
  if (!workspaceOnSharedLine(config, group.workspaceId) || !settings.enabled) return { handled: false, reason: "not_enabled" };

  const gateway = deps.gateway === undefined ? createConversationsGateway() : deps.gateway;

  if (group.status === "retired") {
    // One reply, ever, pointing to the new thread.
    if (gateway && (await markRetiredNoticeSent(db, group.id))) {
      await gateway.postMessage(group.conversationSid, RETIRED_REPLY).catch(() => undefined);
      return { handled: true, action: "retired_notice" };
    }
    return { handled: false, reason: "closed" };
  }

  const ownerUserId = await workspaceOwner(db, group.workspaceId);
  if (!ownerUserId) return { handled: false, reason: "not_enabled" };
  const c: Ctx = { db, group, ownerUserId, deps, now, gateway };

  const authorKey = normalizeConsentPhone(message.author);
  const members = await loadMembers(db, group.id);
  const member = members.find((m) => m.phoneKey === authorKey) ?? null;
  if (!member) return { handled: false, reason: "not_a_member" };

  const body = redactSensitiveNumbers(String(message.body ?? "").trim()).text;
  if (!body && message.mediaCount === 0) return { handled: false, reason: "empty" };
  const cls = classifyGroupText(body);

  const [postsToday, ruleFlags] = await Promise.all([
    countCappedPostsToday(db, group.id, now),
    countRecentFlags(db, group.id, "rule", new Date(now.getTime() - RULE_WINDOW_MS).toISOString()),
  ]);
  const plan = planGroupReply(cls, {
    now,
    postsToday,
    maxPostsPerDay: settings.maxPostsPerDay,
    recentRuleFlags: ruleFlags,
  });

  const logged = await insertMessage(db, {
    groupId: group.id,
    workspaceId: group.workspaceId,
    propertyId: group.propertyId,
    direction: "inbound",
    kind: "message",
    authorPhoneKey: authorKey,
    messageSid: message.messageSid.trim() || null,
    body,
    flag: plan.flag,
    answerCheckAt: plan.checkAt ? plan.checkAt.toISOString() : null,
  });
  if (!logged.ok) return { handled: false, reason: "duplicate" };
  const key = `house-group:${group.id}:${message.messageSid || logged.id}`;
  const done = () => resolveCheck(db, logged.id, null);

  if (cls.command === "leave") {
    await recordOptOut(db, group.workspaceId, authorKey);
    await privateText(c, member, LEAVE_CONFIRM, `${key}:leave`);
    await syncHouseGroup(db, { workspaceId: group.workspaceId, propertyId: group.propertyId, reason: "consent_change" }, { gateway, now: deps.now, ...deps.sync }).catch(() => undefined);
    await done();
    return { handled: true, action: "left_group" };
  }
  if (cls.command === "join") {
    await privateText(c, member, JOIN_CONFIRM, `${key}:join`);
    await done();
    return { handled: true, action: "already_in_group" };
  }

  if (plan.emergency) {
    await say(c, EMERGENCY_SAFETY_REPLY, "emergency", `${key}:emergency`);
    await tellTeam(c, member, `emergency word in the house chat: "${excerpt(body)}"`, "emergency", true, `${key}:alert`);
    await done();
    return { handled: true, action: "emergency" };
  }

  if (plan.escalate) {
    const label = await houseLabelOf(db, group.propertyId);
    const what =
      plan.escalate.category === "repeated_rules"
        ? `repeated house-rule issues at ${label}`
        : `${plan.escalate.category} concern at ${label}`;
    await tellTeam(c, member, `${what}: "${excerpt(body)}"`, "human_request", plan.escalate.urgent, `${key}:escalate`);
    await fileEscalation(c, member, { kind: "item", source: "ra", topic: plan.escalate.category, text: body });
    if (plan.escalate.category === "repeated_rules" && cls.flag === "rule") {
      await sendComplaintFollowUp(db, { workspaceId: group.workspaceId, ownerUserId, phoneE164: member.phoneE164, firstName: member.firstName, idempotencyKey: `${key}:dm` }, deps.sendDirect);
    }
    await done();
    return { handled: true, action: `escalated_${plan.escalate.category}` };
  }

  // A complaint is counted against the house's threshold (House details); the manager hears at N.
  if (cls.flag === "complaint") await fileEscalation(c, member, { kind: "complaint", source: "ra", topic: "complaint", text: body });

  let action = "silent";
  if (plan.groupReply === "answer") {
    action = await answerQuestion(c, member, body, key, false);
    await done();
  } else if (plan.groupReply === "complaint_ack" || plan.groupReply === "rules_reminder") {
    const text = plan.groupReply === "rules_reminder" ? reminderFor(plan, cls.ruleTopic) : COMPLAINT_ACK;
    await say(c, text, plan.groupReply === "rules_reminder" ? "rules" : "complaint_ack", `${key}:group`);
    action = plan.groupReply;
    if (plan.followUpPrivately) {
      await sendComplaintFollowUp(db, { workspaceId: group.workspaceId, ownerUserId, phoneE164: member.phoneE164, firstName: member.firstName, idempotencyKey: `${key}:dm` }, deps.sendDirect);
      action = `${plan.groupReply}+private`;
    }
    await done();
  } else if (plan.answerPrivately) {
    action = await answerQuestion(c, member, body, key, true);
    await done();
  } else if (plan.followUpPrivately && !plan.checkAt) {
    await sendComplaintFollowUp(db, { workspaceId: group.workspaceId, ownerUserId, phoneE164: member.phoneE164, firstName: member.firstName, idempotencyKey: `${key}:dm` }, deps.sendDirect);
    action = "private_follow_up";
    await done();
  } else if (plan.checkAt) {
    action = plan.held ? `held_${plan.held}` : "waiting_for_housemates";
  }
  return { handled: true, action };
}

/**
 * The sweep (every few minutes): house-fact questions nobody answered in ten minutes, and the
 * complaint follow-ups and night-time answers that were held until morning.
 */
export async function runDueGroupChecks(db: SupabaseClient, deps: RaDeps = {}): Promise<{ checked: number; acted: number }> {
  const now = (deps.now ?? (() => new Date()))();
  const gateway = deps.gateway === undefined ? createConversationsGateway() : deps.gateway;
  const due = await loadDueChecks(db, now.toISOString());
  let acted = 0;
  for (const check of due) {
    const group = await loadGroupById(db, check.groupId);
    if (!group || group.status !== "active") {
      await resolveCheck(db, check.id, null);
      continue;
    }
    const ownerUserId = await workspaceOwner(db, group.workspaceId);
    const settings = await loadSettings(db, group.workspaceId);
    if (!ownerUserId || !settings.enabled) {
      await resolveCheck(db, check.id, null);
      continue;
    }
    const members = await loadMembers(db, group.id);
    const member = members.find((m) => m.phoneKey === check.authorPhoneKey) ?? null;
    if (!member) {
      await resolveCheck(db, check.id, null);
      continue;
    }
    const c: Ctx = { db, group, ownerUserId, deps, now, gateway };
    const kind = check.flag === "complaint" || check.flag === "rule" ? "followup" : "question";
    const answered = kind === "question" ? await hasInboundAfter(db, group.id, check.createdAt, check.id) : false;
    const postsToday = await countCappedPostsToday(db, group.id, now);
    const decision = planDueCheck(kind, { now, postsToday, maxPostsPerDay: settings.maxPostsPerDay, recentRuleFlags: 0, answeredByPerson: answered });
    const key = `house-group:${group.id}:check:${check.id}`;
    if (decision.act === "wait") {
      await resolveCheck(db, check.id, (decision.checkAt ?? new Date(now.getTime() + 3_600_000)).toISOString());
      continue;
    }
    if (decision.act === "skip") {
      await resolveCheck(db, check.id, null);
      continue;
    }
    if (decision.act === "follow_up") {
      await sendComplaintFollowUp(db, { workspaceId: group.workspaceId, ownerUserId, phoneE164: member.phoneE164, firstName: member.firstName, idempotencyKey: `${key}:dm` }, deps.sendDirect);
    } else {
      await answerQuestion(c, member, check.body, key, decision.act === "answer_private");
    }
    await resolveCheck(db, check.id, null);
    acted += 1;
  }
  return { checked: due.length, acted };
}

/** "join group" typed in a 1:1 text (or "leave group"): record the choice and re-sync the resident's houses. */
export async function handleGroupPreferenceText(
  db: SupabaseClient,
  input: { fromPhone: string; command: "leave" | "join"; messageSid: string },
  deps: RaDeps = {},
): Promise<{ handled: boolean; reply: string | null }> {
  const e164 = normalizeE164(input.fromPhone);
  if (!e164) return { handled: false, reply: null };
  const phoneKey = normalizeConsentPhone(e164);
  const { loadMembershipsForPhone } = await import("./store.server");
  const memberships = await loadMembershipsForPhone(db, phoneKey);
  const workspaceIds = new Set(memberships.map((m) => m.group.workspaceId));

  // A resident with no group yet may still say "join group": find the houses they live in.
  const extra = await residentHouses(db, phoneKey);
  for (const h of extra) workspaceIds.add(h.workspaceId);
  if (workspaceIds.size === 0) return { handled: false, reply: null };

  const config = await loadSharedLineConfig(db);
  const live = [...workspaceIds].filter((w) => workspaceOnSharedLine(config, w));
  const enabled: string[] = [];
  for (const w of live) if ((await loadSettings(db, w)).enabled) enabled.push(w);
  if (enabled.length === 0) return { handled: false, reply: null };

  for (const workspaceId of enabled) {
    if (input.command === "leave") await recordOptOut(db, workspaceId, phoneKey);
    else await recordConsent(db, workspaceId, phoneKey, "sms_join");
  }
  const houses = new Map<string, string>();
  for (const m of memberships) if (enabled.includes(m.group.workspaceId)) houses.set(m.group.propertyId, m.group.workspaceId);
  for (const h of extra) if (h.propertyId && enabled.includes(h.workspaceId)) houses.set(h.propertyId, h.workspaceId);
  for (const [propertyId, workspaceId] of houses) {
    await syncHouseGroup(db, { workspaceId, propertyId, reason: "consent_change" }, { now: deps.now, gateway: deps.gateway, ...deps.sync }).catch(() => undefined);
  }
  const hasThread = memberships.length > 0;
  return { handled: true, reply: input.command === "leave" ? LEAVE_CONFIRM : hasThread ? JOIN_CONFIRM : JOIN_NEEDS_THREAD };
}

/** Houses this phone is a verified resident of (so "join group" works before the first group exists). */
async function residentHouses(db: SupabaseClient, phoneKey: string): Promise<{ workspaceId: string; propertyId: string | null }[]> {
  try {
    const { findResidentCandidates } = await import("@/lib/one-number/router-lookups.server");
    const found = await findResidentCandidates(db, phoneKey);
    return found.map((f) => ({ workspaceId: f.workspaceId, propertyId: f.propertyId }));
  } catch {
    return [];
  }
}

export { pacificDayKey };
