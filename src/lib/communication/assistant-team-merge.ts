/**
 * The planner behind `scripts/merge-assistant-team-threads.mjs`: pure, so the
 * merge the script prints (and applies) is the merge the tests pin.
 *
 *  (a) Assistant fold - one `agent_notice` row per (user, workspace). The
 *      default workspace's chat is the UNSUFFIXED `agent_notice_<uid>`; rows
 *      that landed under `agent_notice_<uid>__<defaultWorkspaceId>` (a writer
 *      that looked the default workspace up wrongly) fold into it.
 *  (b) Payment-update fold - the per-payment `msg_*` "· Payment update"
 *      person threads fold into the resident's one keyed conversation, using
 *      the same planner and resolver the conversation backfill uses.
 *  (c) Team fold (`--team`) - one Team chat per workspace: the legacy
 *      `team-thread:<owner>` and `team-thread:<owner>:<propertyId>` rows fold
 *      into `team-thread:<owner>:ws:<workspaceId>` (a house -> its workspace,
 *      house-less -> the owner's default workspace). Human lines are unioned by
 *      id in time order; automated notice lines are NOT carried over (a
 *      combined chat would show one house's payments to people without that
 *      house; notices now go to each person's Assistant).
 *
 * Nothing here reads or writes a database.
 */
import {
  parseManagerAgentNoticeThreadId,
  managerAgentNoticeThreadId,
} from "@/lib/communication-manager-assistant-thread";
import {
  planConversationMerges,
  type BackfillAction,
  type BackfillInput,
  type BackfillPlan,
  type BackfillRow,
  type MergeAction,
} from "@/lib/communication/conversation-backfill";
import { parseInboxStampMs } from "@/lib/portal-inbox-storage";
import { parseTeamThreadId, workspaceTeamThreadId } from "@/lib/team-thread-id";
import { TEAM_ROOT_TEXT, teamThreadDisplayName } from "@/lib/team-thread-display";

export type { BackfillRow, BackfillInput };

/** A fold of duplicate Assistant rows into the one canonical row for (user, workspace). */
export type AssistantFoldAction = {
  kind: "assistant-fold";
  userId: string;
  /** Workspace the chat belongs to (the user's default workspace id for the unsuffixed chat). */
  workspaceId: string | null;
  /** The id every writer now targets. */
  canonicalId: string;
  /** True when no row holds `canonicalId` yet, so the fold creates it. */
  createCanonical: boolean;
  /** Existing row whose columns the canonical row keeps (the canonical itself, else the newest). */
  baseId: string;
  absorbIds: string[];
  rowData: Record<string, unknown>;
  turns: number;
};

/** A fold of legacy per-house / house-less Team rows into the one Team chat for (owner, workspace). */
export type TeamFoldAction = {
  kind: "team-fold";
  ownerUserId: string;
  workspaceId: string;
  /** The id every writer now targets: `team-thread:<owner>:ws:<workspace>`. */
  canonicalId: string;
  createCanonical: boolean;
  /** Existing row whose columns the canonical row keeps (the canonical itself, else the newest). */
  baseId: string;
  absorbIds: string[];
  rowData: Record<string, unknown>;
  turns: number;
  /** Automated notice lines that were not carried into the human chat. */
  droppedNotices: number;
  /**
   * The legacy rows held only automated notices (no human line to carry) and no
   * workspace chat exists yet: nothing is created, the legacy rows are retired
   * (they are backed up first). Notices live in each person's Assistant now.
   */
  retire: boolean;
};

export type AssistantTeamAction = AssistantFoldAction | TeamFoldAction | BackfillAction;

export type AssistantTeamPlan = {
  actions: AssistantTeamAction[];
  skipped: { id: string; reason: string }[];
};

const PAYMENT_UPDATE_SUFFIX = /\s·\sPayment update\s*$/;

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function isAssistantNoticeRow(row: Pick<BackfillRow, "id" | "thread_type">): boolean {
  return row.thread_type === "agent_notice" || row.id.startsWith("agent_notice_");
}

export function isPaymentUpdateRow(row: BackfillRow): boolean {
  if (row.thread_type !== "portal_message" && row.thread_type !== null) return false;
  if (!/^msg_/.test(row.id)) return false;
  return PAYMENT_UPDATE_SUFFIX.test(str(row.row_data?.subject));
}

type Msg = Record<string, unknown> & { id: string; at: string };

function messagesOf(row: BackfillRow): Msg[] {
  const list = Array.isArray(row.row_data?.messages) ? (row.row_data!.messages as unknown[]) : [];
  return list.filter((m): m is Msg => Boolean(m) && typeof m === "object" && Boolean(str((m as Msg).id)));
}

function rowMs(row: BackfillRow): number {
  const parsed = Date.parse(row.updated_at ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Fold duplicate Assistant rows. `defaultWorkspaceByUser` maps a user id to the id
 * of their REAL default workspace; a suffix naming it is the default workspace's
 * chat under a wrong id, not a different workspace.
 */
export function planAssistantNoticeFold(
  rows: readonly BackfillRow[],
  defaultWorkspaceByUser: ReadonlyMap<string, string>,
): AssistantTeamPlan {
  const actions: AssistantTeamAction[] = [];
  const skipped: { id: string; reason: string }[] = [];
  const groups = new Map<string, BackfillRow[]>();
  for (const row of rows) {
    if (!isAssistantNoticeRow(row)) continue;
    const parsed = parseManagerAgentNoticeThreadId(row.id);
    if (!parsed) {
      skipped.push({ id: row.id, reason: "unrecognized assistant id (left as is)" });
      continue;
    }
    const defaultId = defaultWorkspaceByUser.get(parsed.userId) ?? "";
    const isDefault = !parsed.workspaceId || (defaultId !== "" && parsed.workspaceId === defaultId);
    const workspaceKey = isDefault ? "default" : parsed.workspaceId!;
    const key = `${parsed.userId}|${workspaceKey}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(row);
    groups.set(key, bucket);
  }

  for (const [key, members] of groups) {
    const [userId = "", workspaceKey = "default"] = key.split("|");
    const isDefault = workspaceKey === "default";
    const defaultId = defaultWorkspaceByUser.get(userId) ?? "";
    const canonicalId = managerAgentNoticeThreadId(
      userId,
      isDefault ? undefined : { id: workspaceKey, isDefault: false },
    );
    // A lone row already on the canonical id is the healthy state; a lone row on
    // the default workspace's suffixed id still moves to the canonical one.
    if (members.length < 2 && members[0]!.id === canonicalId) continue;
    const holder = members.find((row) => row.id === canonicalId);
    const base = holder ?? [...members].sort((a, b) => rowMs(b) - rowMs(a) || a.id.localeCompare(b.id))[0]!;
    const ordered = [base, ...members.filter((row) => row.id !== base.id)];

    const seen = new Set<string>();
    const all: { msg: Msg; order: number }[] = [];
    ordered.forEach((member, memberIndex) => {
      messagesOf(member).forEach((msg, index) => {
        if (seen.has(msg.id)) return;
        seen.add(msg.id);
        all.push({ msg, order: memberIndex * 10_000 + index });
      });
    });
    all.sort(
      (a, b) =>
        (parseInboxStampMs(String(a.msg.at)) ?? a.order) - (parseInboxStampMs(String(b.msg.at)) ?? b.order) ||
        a.order - b.order,
    );
    const messages = all.map((entry) => entry.msg);
    const latest = messages[messages.length - 1];
    const baseData = base.row_data ?? {};
    const newest = [...members].sort((a, b) => rowMs(b) - rowMs(a))[0]!;
    const newestData = newest.row_data ?? {};
    const rowData: Record<string, unknown> = {
      ...baseData,
      id: canonicalId,
      threadType: "agent_notice",
      messages,
      preview: latest ? str(latest.body).slice(0, 100).replace(/\n/g, " ") : (baseData.preview ?? ""),
      time: str(newestData.time) || baseData.time,
      body: str(newestData.body) ? newestData.body : baseData.body,
      subject: str(newestData.subject) || baseData.subject,
      unread: members.some((member) => member.row_data?.unread === true),
      folder: members.some((member) => str(member.row_data?.folder) !== "trash") ? "inbox" : "trash",
    };
    const absorbIds = members.filter((row) => row.id !== canonicalId).map((row) => row.id);
    actions.push({
      kind: "assistant-fold",
      userId,
      workspaceId: isDefault ? (defaultId || null) : workspaceKey,
      canonicalId,
      createCanonical: !holder,
      baseId: base.id,
      absorbIds,
      rowData,
      turns: messages.length,
    });
  }
  return { actions, skipped };
}

/**
 * Fold the per-payment person threads. `inputs` carries EVERY person-thread of the
 * owners that have such a row, each with its resolved conversation ref, so the key
 * holder is among them. Only merges/stamps that involve a payment-update row are
 * kept: this pass never reshuffles other conversations.
 */
export function planPaymentUpdateFold(inputs: readonly BackfillInput[]): BackfillPlan {
  const paymentIds = new Set(inputs.filter(({ row }) => isPaymentUpdateRow(row)).map(({ row }) => row.id));
  // The planner sees the payment rows plus the row that ALREADY holds the
  // resident's key (the conversation they fold into). Any other thread of the
  // same person (a seeded showcase thread, an application thread) is not this
  // pass's business and is never absorbed.
  const scoped = inputs.filter(
    ({ row, ref }) =>
      paymentIds.has(row.id) ||
      (ref !== null && row.conversation_key === ref.key && row.workspace_id === ref.workspaceId),
  );
  const full = planConversationMerges(scoped);
  const actions = full.actions.filter((action) => {
    if (action.kind === "merge") return [action.keepId, ...action.absorbIds].some((id) => paymentIds.has(id));
    return paymentIds.has(action.id);
  });
  const skipped = full.skipped.filter((skip) => paymentIds.has(skip.id));
  return { actions, skipped };
}

export type TeamFoldContext = {
  /** House id -> the workspace that holds it. */
  workspaceByHouse: ReadonlyMap<string, string>;
  /** Owner id -> their REAL default workspace id (where house-less chats and unplaced houses go). */
  defaultWorkspaceByOwner: ReadonlyMap<string, string>;
  /** Workspace id -> its name (the chat is "Team · <name>"). */
  workspaceNameById: ReadonlyMap<string, string>;
  /** User id -> display name, for the legacy root turn that was dressed as the thread. */
  nameByUserId: ReadonlyMap<string, string>;
};

/** A line the automation bus (not a person) posted into a Team thread. */
export function isAutomatedTeamLine(id: string): boolean {
  return id.startsWith("action-event:");
}

/** Pure: the legacy Team rows of every owner -> one fold per (owner, workspace). */
export function planTeamThreadFold(
  rows: readonly BackfillRow[],
  context: TeamFoldContext = {
    workspaceByHouse: new Map(),
    defaultWorkspaceByOwner: new Map(),
    workspaceNameById: new Map(),
    nameByUserId: new Map(),
  },
): AssistantTeamPlan {
  const actions: AssistantTeamAction[] = [];
  const skipped: { id: string; reason: string }[] = [];
  const groups = new Map<string, { ownerId: string; workspaceId: string; members: BackfillRow[] }>();
  for (const row of rows) {
    const parsed = parseTeamThreadId(row.id);
    if (!parsed) {
      if (row.thread_type === "team") skipped.push({ id: row.id, reason: "unrecognized team id (left as is)" });
      continue;
    }
    const ownerId = parsed.ownerManagerUserId;
    const workspaceId =
      parsed.workspaceId ??
      (parsed.propertyId ? context.workspaceByHouse.get(parsed.propertyId) : undefined) ??
      context.defaultWorkspaceByOwner.get(ownerId) ??
      "";
    if (!workspaceId) {
      skipped.push({ id: row.id, reason: "no workspace for this owner or house (left as is)" });
      continue;
    }
    const key = `${ownerId}|${workspaceId}`;
    const group = groups.get(key) ?? { ownerId, workspaceId, members: [] };
    group.members.push(row);
    groups.set(key, group);
  }

  for (const { ownerId, workspaceId, members } of groups.values()) {
    const canonicalId = workspaceTeamThreadId(ownerId, workspaceId);
    // A lone row already on the canonical id is the healthy state.
    if (members.length < 2 && members[0]!.id === canonicalId) continue;
    const holder = members.find((row) => row.id === canonicalId);
    const base = holder ?? [...members].sort((a, b) => rowMs(b) - rowMs(a) || a.id.localeCompare(b.id))[0]!;
    const ordered = [base, ...members.filter((row) => row.id !== base.id)];

    const seen = new Set<string>();
    const all: { msg: Msg; order: number }[] = [];
    let droppedNotices = 0;
    const take = (msg: Msg, order: number) => {
      if (seen.has(msg.id)) return;
      seen.add(msg.id);
      if (isAutomatedTeamLine(msg.id)) {
        droppedNotices += 1;
        return;
      }
      all.push({ msg, order });
    };
    ordered.forEach((member, memberIndex) => {
      const data = member.row_data ?? {};
      // A legacy root turn is a real first line (named after the thread, which is
      // wrong): carry it over as a message from its actual author.
      const rootId = str(data.rootMessageId);
      const rootBody = str(data.body);
      if (rootId && rootBody && !rootId.startsWith("team-root:")) {
        const actorId = str(data.rootActorUserId);
        const legacyFrom = str(data.from);
        const author =
          context.nameByUserId.get(actorId) || (legacyFrom && !legacyFrom.startsWith("Team") ? legacyFrom : "A teammate");
        take(
          {
            id: rootId,
            from: author,
            body: rootBody,
            at: str(data.rootAt) || str(data.time),
            outbound: true,
            ...(actorId ? { actorUserId: actorId } : {}),
            channel: "proplane",
          } as Msg,
          memberIndex * 10_000 - 1,
        );
      }
      messagesOf(member).forEach((msg, index) => {
        take({ ...msg, channel: msg.channel ?? "proplane" } as Msg, memberIndex * 10_000 + index);
      });
    });
    all.sort(
      (a, b) =>
        (parseInboxStampMs(String(a.msg.at)) ?? a.order) - (parseInboxStampMs(String(b.msg.at)) ?? b.order) ||
        a.order - b.order,
    );
    const messages = all.map((entry) => entry.msg);
    const latest = messages[messages.length - 1];
    const baseData = base.row_data ?? {};
    const newest = [...members].sort((a, b) => rowMs(b) - rowMs(a))[0]!;
    const newestData = newest.row_data ?? {};
    const name = teamThreadDisplayName(context.workspaceNameById.get(workspaceId));
    // The fold writes a fresh, human-only row: house tags and review drafts of
    // the per-house threads do not describe a workspace chat.
    const {
      propertyId: _propertyId,
      propertyTitle: _propertyTitle,
      aiDraft: _aiDraft,
      aiDraftQueue: _aiDraftQueue,
      rootActorUserId: _rootActorUserId,
      rootOutbound: _rootOutbound,
      ...kept
    } = baseData as Record<string, unknown>;
    void [_propertyId, _propertyTitle, _aiDraft, _aiDraftQueue, _rootActorUserId, _rootOutbound];
    const rowData: Record<string, unknown> = {
      ...kept,
      id: canonicalId,
      from: name,
      subject: name,
      body: TEAM_ROOT_TEXT,
      rootMessageId: `team-root:${canonicalId}`,
      rootAt: str(messages[0]?.at) || str(baseData.rootAt) || str(baseData.time),
      rootOutbound: false,
      workspaceId,
      messages,
      preview: latest ? str(latest.body).slice(0, 100).replace(/\n/g, " ") : str(baseData.preview),
      time: latest ? str(latest.at) : str(newestData.time) || baseData.time,
      unread: members.some((member) => member.row_data?.unread === true),
      folder: members.some((member) => str(member.row_data?.folder) !== "trash") ? "inbox" : "trash",
    };
    actions.push({
      kind: "team-fold",
      ownerUserId: ownerId,
      workspaceId,
      canonicalId,
      createCanonical: !holder,
      baseId: base.id,
      absorbIds: members.filter((row) => row.id !== canonicalId).map((row) => row.id),
      rowData,
      turns: messages.length,
      droppedNotices,
      retire: !holder && messages.length === 0,
    });
  }
  return { actions, skipped };
}

export function isMergeAction(action: AssistantTeamAction): action is MergeAction {
  return action.kind === "merge";
}

/** Every row id an action reads or writes - the set that is backed up before any write. */
export function touchedIds(action: AssistantTeamAction): string[] {
  if (action.kind === "assistant-fold" || action.kind === "team-fold") {
    return [action.baseId, action.canonicalId, ...action.absorbIds];
  }
  if (action.kind === "merge") return [action.keepId, ...action.absorbIds];
  return [action.id];
}

export function describeAssistantTeamPlan(plan: AssistantTeamPlan): string[] {
  const lines: string[] = [];
  for (const action of plan.actions) {
    if (action.kind === "assistant-fold") {
      lines.push(
        `FOLD   assistant user=${action.userId.slice(0, 8)} -> ${action.canonicalId}${action.createCanonical ? " (create)" : ""}  absorb=[${action.absorbIds.join(", ")}]  turns=${action.turns}`,
      );
    } else if (action.kind === "team-fold") {
      lines.push(
        `${action.retire ? "RETIRE" : "FOLD  "} team owner=${action.ownerUserId.slice(0, 8)} ws=${action.workspaceId.slice(0, 8)} -> ${action.retire ? "(notice-only: no chat created)" : action.canonicalId}${action.createCanonical && !action.retire ? " (create)" : ""}  absorb=[${action.absorbIds.join(", ")}]  turns=${action.turns}  dropped-notices=${action.droppedNotices}`,
      );
    } else if (action.kind === "merge") {
      lines.push(
        `MERGE  payment-updates owner=${(action.ownerUserId ?? "-").slice(0, 8)} keep=${action.keepId}  absorb=[${action.absorbIds.join(", ")}]  turns=${action.turns}`,
      );
    } else if (action.kind === "stamp") {
      lines.push(`STAMP  ${action.id}`);
    } else {
      lines.push(`NOTICE ${action.id}`);
    }
  }
  for (const skip of plan.skipped) lines.push(`SKIP   ${skip.id}  (${skip.reason})`);
  return lines;
}
