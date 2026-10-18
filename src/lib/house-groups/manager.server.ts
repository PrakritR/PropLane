import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { sendSharedLineMessage } from "@/lib/one-number/send.server";
import { readSharedLineConfig, sharedLineActiveFor } from "@/lib/one-number/shared-line-number.server";
import { alertWorkspaceTeam } from "@/lib/one-number/team-alerts.server";
import { propertyLabel } from "@/lib/one-number/router-lookups.server";
import { complaintFollowUp, introText, joinOffer, leaverGoodbye } from "./copy";
import { createConversationsGateway } from "./conversations-gateway.server";
import { diffMembers, memberHash, selectGroupMembers } from "./members";
import { postToHouseGroup, type PostDeps } from "./post.server";
import { loadHouseResidentCandidates } from "./residents.server";
import {
  findGroupByHash,
  insertGroup,
  insertMembers,
  loadActiveGroup,
  loadMembers,
  loadSettings,
  setGroupStatus,
  workspaceOwner,
  type GroupRow,
} from "./store.server";
import { inHouseQuietHours, pacificDayKey } from "./time";
import type { ConversationsGateway, GroupMember, ResidentCandidate } from "./types";

export type SyncReason = "daily" | "early_move_out" | "manager" | "consent_change";

export type SyncOutcome =
  | "disabled"
  | "not_found"
  | "unchanged"
  | "created"
  | "replaced"
  | "reactivated"
  | "retired"
  | "too_few"
  | "deferred_quiet_hours"
  | "error";

export type SyncResult = {
  propertyId: string;
  outcome: SyncOutcome;
  members: number;
  /** Eligible residents past the nine seats: they get 1:1 texts and the manager sees a warning. */
  overflow: number;
};

export type SyncDeps = {
  gateway?: ConversationsGateway | null;
  now?: () => Date;
  loadCandidates?: (propertyId: string) => Promise<ResidentCandidate[]>;
  sendDirect?: (input: { workspaceId: string; ownerUserId: string; toPhone: string; body: string; idempotencyKey: string }) => Promise<unknown>;
  alert?: typeof alertWorkspaceTeam;
  post?: PostDeps;
};

type Row = Record<string, unknown>;

async function loadHouse(db: SupabaseClient, workspaceId: string, ownerUserId: string, propertyId: string): Promise<{ label: string } | null> {
  try {
    const { data } = await db
      .from("manager_property_records")
      .select("id, workspace_id, manager_user_id, row_data")
      .eq("id", propertyId)
      .maybeSingle();
    const row = data as Row | null;
    if (!row) return null;
    const ws = String(row.workspace_id ?? "").trim();
    const owner = String(row.manager_user_id ?? "").trim();
    if (ws ? ws !== workspaceId : owner !== ownerUserId) return null;
    return { label: propertyLabel(row.row_data) || "your house" };
  } catch {
    return null;
  }
}

async function sendDirectDefault(
  db: SupabaseClient,
  input: { workspaceId: string; ownerUserId: string; toPhone: string; body: string; idempotencyKey: string },
): Promise<unknown> {
  return sendSharedLineMessage(db, {
    workspaceId: input.workspaceId,
    ownerUserId: input.ownerUserId,
    toPhone: input.toPhone,
    body: input.body,
    role: "resident",
    idempotencyKey: input.idempotencyKey,
  });
}

/**
 * Make a house's group match its residents. Idempotent: it reads who SHOULD be in the group,
 * compares it to who IS, and does nothing when they match. A group is defined by its member list,
 * so any difference makes a NEW Conversation (intro posted, "the old one is retired" when replacing)
 * and retires the old one, which stays open to answer one stray text. A retired group whose exact
 * list comes back is reactivated instead of duplicated. Nothing is created or replaced between
 * 10 pm and 8 am: the next run (daily, or on demand) does it.
 */
export async function syncHouseGroup(
  db: SupabaseClient,
  input: { workspaceId: string; propertyId: string; reason: SyncReason },
  deps: SyncDeps = {},
): Promise<SyncResult> {
  const { workspaceId, propertyId } = input;
  const base: SyncResult = { propertyId, outcome: "disabled", members: 0, overflow: 0 };
  const now = (deps.now ?? (() => new Date()))();

  const config = await readSharedLineConfig(db);
  if (!sharedLineActiveFor(config, workspaceId) || !config.sharedNumber) return base;
  const settings = await loadSettings(db, workspaceId);
  if (!settings.enabled) return base;

  const ownerUserId = await workspaceOwner(db, workspaceId);
  if (!ownerUserId) return { ...base, outcome: "not_found" };
  const house = await loadHouse(db, workspaceId, ownerUserId, propertyId);
  if (!house) return { ...base, outcome: "not_found" };

  const today = pacificDayKey(now);
  const candidates = deps.loadCandidates
    ? await deps.loadCandidates(propertyId)
    : await loadHouseResidentCandidates(db, { ownerUserId, workspaceId, propertyId, today });
  const selection = selectGroupMembers(candidates);
  const alert = deps.alert ?? alertWorkspaceTeam;
  const sendDirect = deps.sendDirect ?? ((i) => sendDirectDefault(db, i));
  const quiet = inHouseQuietHours(now);
  const result = (outcome: SyncOutcome): SyncResult => ({
    propertyId,
    outcome,
    members: selection.members.length,
    overflow: selection.overflow.length,
  });

  if (selection.overflow.length > 0) {
    await alert(db, {
      workspaceId,
      ownerUserId,
      kind: "unanswered",
      urgent: false,
      propertyId,
      text: `${house.label}: the house chat holds ${selection.members.length} residents. ${selection.overflow.length} more get texts one on one.`,
      idempotencyKey: `house-group-overflow:${propertyId}:${today}`,
    }).catch(() => undefined);
  }

  // A resident who lives here but has not agreed yet is asked once, privately. Never at night.
  if (!quiet) {
    for (const c of candidates) {
      if (c.longTerm && c.verifiedPhone && !c.consented && !c.optedOut && !c.stopped) {
        await Promise.resolve(
          sendDirect({
            workspaceId,
            ownerUserId,
            toPhone: c.phoneE164,
            body: joinOffer(c.firstName),
            idempotencyKey: `house-group-offer:${workspaceId}:${c.phoneKey}`,
          }),
        ).catch(() => undefined);
      }
    }
  }

  const current = await loadActiveGroup(db, propertyId);
  const currentMembers = current ? await loadMembers(db, current.id) : [];
  const desiredKeys = selection.members.map((m) => m.phoneKey);
  const desiredHash = memberHash(desiredKeys);

  if (selection.tooFew) {
    if (!current) return result("too_few");
    if (quiet) return result("deferred_quiet_hours");
    await setGroupStatus(db, current.id, "retired");
    await sayGoodbye(db, { workspaceId, ownerUserId, house: house.label, leavers: currentMembers, sendDirect });
    return result("retired");
  }

  if (current && current.memberHash === desiredHash && diffMembers(currentMembers.map((m) => m.phoneKey), desiredKeys).same) {
    return result("unchanged");
  }
  if (quiet) return result("deferred_quiet_hours");

  const gateway = deps.gateway === undefined ? createConversationsGateway() : deps.gateway;
  if (!gateway) return result("error");

  const diff = diffMembers(currentMembers.map((m) => m.phoneKey), desiredKeys);
  const newcomers = selection.members.filter((m) => diff.added.includes(m.phoneKey));
  const leavers = currentMembers.filter((m) => diff.removed.includes(m.phoneKey));

  // The old group steps aside first (only one active group per house), and comes back if the new one fails.
  const retiredBefore = current ? await setGroupStatus(db, current.id, "retired") : false;
  const restoreOld = async () => {
    if (current && retiredBefore) await setGroupStatus(db, current.id, "active");
  };

  // The exact same list as a group we retired earlier: wake that one up.
  const earlier = await findGroupByHash(db, propertyId, desiredHash, ["retired"]);
  if (earlier) {
    if (!(await setGroupStatus(db, earlier.id, "active"))) {
      await restoreOld();
      return result("error");
    }
    await postToHouseGroup(
      db,
      {
        workspaceId,
        propertyId,
        text: "This house thread is active again.",
        kind: "intro",
        idempotencyKey: `house-group-reactivated:${earlier.id}:${today}`,
      },
      { gateway, now: deps.now, ...deps.post },
    );
    await sayGoodbye(db, { workspaceId, ownerUserId, house: house.label, leavers, sendDirect });
    return result("reactivated");
  }

  let created: GroupRow | null = null;
  let conversationSid: string | null = null;
  try {
    const conversation = await gateway.createConversation({ friendlyName: `House ${house.label}`.slice(0, 120) });
    conversationSid = conversation.sid;
    await gateway.watchConversation(conversation.sid);
    const joined: (GroupMember & { participantSid: string })[] = [];
    for (const member of selection.members) {
      const { participantSid } = await gateway.addResident(conversation.sid, member.phoneE164);
      joined.push({ ...member, participantSid });
    }
    await gateway.addProplane(conversation.sid, config.sharedNumber);
    created = await insertGroup(db, { workspaceId, propertyId, conversationSid: conversation.sid, memberHash: desiredHash });
    if (!created) throw new Error("group_row_not_saved");
    await insertMembers(db, created.id, joined);
  } catch (error) {
    console.error("house group create failed", error instanceof Error ? error.message : "unknown");
    if (conversationSid) await gateway.closeConversation(conversationSid).catch(() => undefined);
    await restoreOld();
    return result("error");
  }

  if (current) await setGroupStatus(db, current.id, "retired", { supersededBy: created.id });
  const posted = await postToHouseGroup(
    db,
    {
      workspaceId,
      propertyId,
      text: introText(selection.members, { replacing: Boolean(current), newcomers }),
      kind: "intro",
      idempotencyKey: `house-group-intro:${created.id}`,
    },
    { gateway, now: deps.now, ...deps.post },
  );
  if (!posted.ok) console.error("house group intro not posted", posted.reason, posted.detail ?? "");
  await sayGoodbye(db, { workspaceId, ownerUserId, house: house.label, leavers, sendDirect });
  return result(current ? "replaced" : "created");
}

async function sayGoodbye(
  db: SupabaseClient,
  input: {
    workspaceId: string;
    ownerUserId: string;
    house: string;
    leavers: readonly { phoneKey: string; phoneE164: string; firstName: string }[];
    sendDirect: NonNullable<SyncDeps["sendDirect"]>;
  },
): Promise<void> {
  void db;
  for (const leaver of input.leavers) {
    await Promise.resolve(
      input.sendDirect({
        workspaceId: input.workspaceId,
        ownerUserId: input.ownerUserId,
        toPhone: leaver.phoneE164,
        body: leaverGoodbye(leaver.firstName, input.house, null),
        idempotencyKey: `house-group-goodbye:${input.workspaceId}:${leaver.phoneKey}:${pacificDayKey(new Date())}`,
      }),
    ).catch(() => undefined);
  }
}

/** The 1:1 that follows a complaint in the group, through the normal resident path. */
export async function sendComplaintFollowUp(
  db: SupabaseClient,
  input: { workspaceId: string; ownerUserId: string; phoneE164: string; firstName: string; idempotencyKey: string },
  sendDirect?: SyncDeps["sendDirect"],
): Promise<void> {
  const send = sendDirect ?? ((i) => sendDirectDefault(db, i));
  await Promise.resolve(
    send({
      workspaceId: input.workspaceId,
      ownerUserId: input.ownerUserId,
      toPhone: input.phoneE164,
      body: complaintFollowUp(input.firstName),
      idempotencyKey: input.idempotencyKey,
    }),
  ).catch(() => undefined);
}

export type SweepSummary = { checked: number; created: number; replaced: number; retired: number; reactivated: number; errors: number; deferred: number };

/** The daily batch: every house of every workspace that turned house chat on. */
export async function syncAllHouseGroups(db: SupabaseClient, deps: SyncDeps = {}, reason: SyncReason = "daily"): Promise<SweepSummary> {
  const summary: SweepSummary = { checked: 0, created: 0, replaced: 0, retired: 0, reactivated: 0, errors: 0, deferred: 0 };
  let enabled: Row[] = [];
  try {
    const { data } = await db.from("house_group_settings").select("workspace_id").eq("enabled", true).limit(500);
    enabled = (data ?? []) as Row[];
  } catch {
    return summary;
  }
  for (const w of enabled) {
    const workspaceId = String(w.workspace_id ?? "");
    if (!workspaceId) continue;
    let houses: Row[] = [];
    try {
      const { data } = await db.from("manager_property_records").select("id").eq("workspace_id", workspaceId).limit(500);
      houses = (data ?? []) as Row[];
    } catch {
      continue;
    }
    for (const h of houses) {
      const propertyId = String(h.id ?? "");
      if (!propertyId) continue;
      summary.checked += 1;
      try {
        const r = await syncHouseGroup(db, { workspaceId, propertyId, reason }, deps);
        if (r.outcome === "created") summary.created += 1;
        else if (r.outcome === "replaced") summary.replaced += 1;
        else if (r.outcome === "retired") summary.retired += 1;
        else if (r.outcome === "reactivated") summary.reactivated += 1;
        else if (r.outcome === "error") summary.errors += 1;
        else if (r.outcome === "deferred_quiet_hours") summary.deferred += 1;
      } catch {
        summary.errors += 1;
      }
    }
  }
  return summary;
}

/** Close groups retired for more than 30 days (they have outlived any stray reply). */
export async function closeStaleRetiredGroups(db: SupabaseClient, gateway: ConversationsGateway | null, now: Date = new Date()): Promise<number> {
  if (!gateway) return 0;
  const cutoff = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  let closed = 0;
  try {
    const { data } = await db.from("house_group_conversations").select("id, conversation_sid, retired_at").eq("status", "retired").lt("retired_at", cutoff).limit(100);
    for (const g of (data ?? []) as Row[]) {
      try {
        await gateway.closeConversation(String(g.conversation_sid));
        await setGroupStatus(db, String(g.id), "closed");
        closed += 1;
      } catch {
        /* the next daily run tries again */
      }
    }
  } catch {
    return closed;
  }
  return closed;
}
