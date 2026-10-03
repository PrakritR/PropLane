/**
 * The planner behind `scripts/merge-conversations-backfill.mjs`: pure, so the
 * merge it prints (and applies) is the merge the tests pin.
 *
 * Input: every stored person-thread of one owner, each already resolved to a
 * `ConversationRef` by the SAME resolver the writers use (account -> verified
 * phone -> email). Output: what to do, with nothing applied here.
 *
 *  - Rows that resolve to the same (scope, owner, workspace, key) fold into ONE
 *    conversation. The newest keeps its id; every other id becomes an alias.
 *  - A row whose identity is flagged (two accounts verified one phone) is never
 *    folded into anything: it keeps its own key and is reported.
 *  - A row with no resolvable identity is left alone and reported.
 *  - SMS compatibility notices (their ids, archive controls and source markers
 *    are keyed to the phone) and a vendor's own work-identity inbox are stamped
 *    with their key, never folded.
 *  - A second run over the result plans nothing (idempotent), which is what
 *    "two clean passes" checks.
 */
import { PERSONAL_WORKSPACE_ID, type ConversationFlag } from "@/lib/communication/conversation-key";
import { parseInboxStampMs } from "@/lib/portal-inbox-storage";

export type BackfillRow = {
  id: string;
  scope: string;
  owner_user_id: string | null;
  participant_email: string | null;
  thread_type: string | null;
  row_data: Record<string, unknown> | null;
  updated_at: string | null;
  conversation_key?: string | null;
  workspace_id?: string | null;
};

export type BackfillRef = {
  workspaceId: string;
  key: string;
  keys: string[];
  flagged: ConversationFlag | null;
};

export type BackfillInput = { row: BackfillRow; ref: BackfillRef | null };

export type MergeAction = {
  kind: "merge";
  keepId: string;
  absorbIds: string[];
  scope: string;
  ownerUserId: string | null;
  participantEmail: string | null;
  threadType: string;
  workspaceId: string;
  key: string;
  rowData: Record<string, unknown>;
  /** Count of turns the merged conversation holds, for the printed plan. */
  turns: number;
};
export type StampAction = { kind: "stamp"; id: string; workspaceId: string; key: string };
export type StampRowDataAction = { kind: "stamp-row-data"; id: string; workspaceId: string; key: string; flagged: ConversationFlag | null };
export type BackfillAction = MergeAction | StampAction | StampRowDataAction;
export type BackfillSkip = { id: string; reason: string };

export type BackfillPlan = { actions: BackfillAction[]; skipped: BackfillSkip[] };

const UNMERGEABLE_TYPES = new Set(["agent_notice", "team", "vendor_agent", "resident_agent"]);

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isNoticeRow(row: BackfillRow): boolean {
  const data = row.row_data ?? {};
  return (
    /^(sms_notice_|claw_lease_|claw_resident_|sms_relay_)/.test(row.id) ||
    String(row.thread_type ?? "").includes("sms_notice") ||
    Boolean(str(data.smsNoticePhone))
  );
}

function skipReason(row: BackfillRow): string | null {
  if (row.scope === "admin") return "admin inbox";
  if (UNMERGEABLE_TYPES.has(String(row.thread_type ?? ""))) return `${row.thread_type} thread`;
  if (/^(agent_notice_|team-thread:)/.test(row.id)) return "assistant / team thread";
  if (row.row_data?.unverifiedLead === true || /:unverified$/.test(row.id)) return "unverified lead (stays separate)";
  return null;
}

type Turn = Record<string, unknown> & { id: string; at: string; body: string };

function memberTurns(row: BackfillRow): Turn[] {
  const data = row.row_data ?? {};
  const legacyHouse = str(data.conversationKey) ? "" : str(data.propertyId);
  const rootHouse = str(data.rootHouseId) || legacyHouse;
  const messages = (Array.isArray(data.messages) ? data.messages : []) as Record<string, unknown>[];
  const rootAt = str(data.rootAt) || str(messages[0]?.at) || str(data.time);
  const rootOutbound =
    data.rootOutbound === true ? true : data.rootOutbound === false ? false : str(data.folder) === "sent";
  const root: Turn = {
    id: str(data.rootMessageId) || `${row.id}-root`,
    from: str(data.from),
    body: String(data.body ?? ""),
    at: rootAt,
    outbound: rootOutbound,
    ...(str(data.rootChannel) ? { channel: data.rootChannel } : {}),
    ...(str(data.rootSubject) ? { subject: data.rootSubject } : {}),
    ...(Array.isArray(data.attachments) && data.attachments.length ? { attachments: data.attachments } : {}),
    ...(data.rootAutomated ? { automated: true } : {}),
    ...(str(data.rootDelivery) ? { delivery: data.rootDelivery } : {}),
    ...(rootHouse ? { houseId: rootHouse } : {}),
    ...(str(data.rootHouseLabel) || (rootHouse && str(data.propertyTitle) && !str(data.conversationKey))
      ? { houseLabel: str(data.rootHouseLabel) || str(data.propertyTitle) }
      : {}),
  };
  const rest = messages
    .filter((message) => message && typeof message === "object" && str(message.id))
    .map((message) => {
      const house = str(message.houseId) || legacyHouse;
      return {
        ...message,
        id: str(message.id),
        at: String(message.at ?? ""),
        body: String(message.body ?? ""),
        ...(house ? { houseId: house } : {}),
        ...(str(message.houseLabel) || (house && str(data.propertyTitle) && !str(data.conversationKey))
          ? { houseLabel: str(message.houseLabel) || str(data.propertyTitle) }
          : {}),
      } as Turn;
    });
  return [root, ...rest];
}

function sortMs(turn: Turn, fallback: number): number {
  return parseInboxStampMs(turn.at) ?? fallback;
}

/** Fold the members' histories into one chronological conversation. */
export function mergeConversationRows(
  members: BackfillRow[],
  keep: BackfillRow,
  ref: BackfillRef,
): { rowData: Record<string, unknown>; turns: number; absorbed: string[] } {
  const keepData = keep.row_data ?? {};
  const seen = new Set<string>();
  const all: { turn: Turn; order: number }[] = [];
  members.forEach((member, memberIndex) => {
    memberTurns(member).forEach((turn, index) => {
      if (seen.has(turn.id)) return;
      seen.add(turn.id);
      all.push({ turn, order: memberIndex * 10_000 + index });
    });
  });
  all.sort((a, b) => sortMs(a.turn, a.order) - sortMs(b.turn, b.order) || a.order - b.order);

  // A reply typed in a person thread is stored twice (the thread and the sent
  // copy's root): drop an outbound turn that repeats an earlier one in text and time.
  const kept: Turn[] = [];
  const outboundSeen = new Set<string>();
  for (const { turn } of all) {
    if (turn.outbound === true) {
      const sig = `${turn.at}\u0000${turn.body.trim()}`;
      if (outboundSeen.has(sig)) continue;
      outboundSeen.add(sig);
    }
    kept.push(turn);
  }
  const [first, ...rest] = kept;
  const latest = rest[rest.length - 1] ?? first;
  const aliasIds = new Set<string>();
  for (const member of members) {
    if (member.id !== keep.id) aliasIds.add(member.id);
    for (const id of (Array.isArray(member.row_data?.aliasIds) ? (member.row_data!.aliasIds as unknown[]) : [])) {
      if (str(id) && str(id) !== keep.id) aliasIds.add(str(id));
    }
  }
  const recordRef = members.map((member) => member.row_data?.recordRef).find((value) => value && typeof value === "object");
  const rowData: Record<string, unknown> = {
    ...keepData,
    id: keep.id,
    body: first?.body ?? keepData.body ?? "",
    from: first?.from || keepData.from,
    rootAt: first?.at,
    rootMessageId: first?.id,
    rootOutbound: first?.outbound === true,
    rootChannel: first?.channel,
    rootSubject: first?.subject,
    rootAutomated: first?.automated,
    rootDelivery: first?.delivery,
    rootHouseId: first?.houseId,
    rootHouseLabel: first?.houseLabel,
    attachments: first?.attachments,
    messages: rest,
    preview: (latest?.body ?? "").slice(0, 100).replace(/\n/g, " "),
    time: latest?.at || keepData.time,
    unread: members.some((member) => member.row_data?.unread === true),
    ...(recordRef ? { recordRef } : {}),
    aliasIds: [...aliasIds],
    conversationKey: ref.key,
    workspaceId: ref.workspaceId,
    ...(ref.flagged ? { identityFlag: ref.flagged } : {}),
  };
  // Legacy per-property fields describe ONE house; the turns now say which.
  delete rowData.propertyId;
  delete rowData.propertyTitle;
  return { rowData, turns: kept.length, absorbed: [...aliasIds] };
}

function rowTimeMs(row: BackfillRow): number {
  const parsed = Date.parse(row.updated_at ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

export function planConversationMerges(inputs: readonly BackfillInput[]): BackfillPlan {
  const actions: BackfillAction[] = [];
  const skipped: BackfillSkip[] = [];
  const groups = new Map<string, { row: BackfillRow; ref: BackfillRef }[]>();

  for (const { row, ref } of inputs) {
    const skip = skipReason(row);
    if (skip) {
      skipped.push({ id: row.id, reason: skip });
      continue;
    }
    if (!ref) {
      skipped.push({ id: row.id, reason: "no identity resolved (left as is)" });
      continue;
    }
    if (isNoticeRow(row) || ref.workspaceId === PERSONAL_WORKSPACE_ID) {
      const data = row.row_data ?? {};
      if (str(data.conversationKey) !== ref.key || str(data.workspaceId) !== ref.workspaceId) {
        actions.push({ kind: "stamp-row-data", id: row.id, workspaceId: ref.workspaceId, key: ref.key, flagged: ref.flagged });
      }
      continue;
    }
    if (ref.flagged) {
      // Ambiguous identity: it stands alone under its phone key, flagged for the manager to choose.
      skipped.push({ id: row.id, reason: `${ref.flagged.reason}: kept separate` });
      if (row.conversation_key !== ref.key || row.workspace_id !== ref.workspaceId) {
        actions.push({ kind: "stamp", id: row.id, workspaceId: ref.workspaceId, key: ref.key });
      }
      continue;
    }
    const groupKey = [row.scope, row.owner_user_id ?? `p:${String(row.participant_email ?? "").toLowerCase()}`, ref.workspaceId, ref.key].join("|");
    const bucket = groups.get(groupKey) ?? [];
    bucket.push({ row, ref });
    groups.set(groupKey, bucket);
  }

  for (const members of groups.values()) {
    const ref = members[0]!.ref;
    if (members.length === 1) {
      const { row } = members[0]!;
      if (row.conversation_key !== ref.key || row.workspace_id !== ref.workspaceId) {
        actions.push({ kind: "stamp", id: row.id, workspaceId: ref.workspaceId, key: ref.key });
      }
      continue;
    }
    // The row already holding this key (if any) keeps its id; otherwise the newest.
    const rows = members.map((member) => member.row);
    const holder = rows.find((row) => row.conversation_key === ref.key && row.workspace_id === ref.workspaceId);
    const keep = holder ?? [...rows].sort((a, b) => rowTimeMs(b) - rowTimeMs(a) || a.id.localeCompare(b.id))[0]!;
    const ordered = [keep, ...rows.filter((row) => row.id !== keep.id)];
    const merged = mergeConversationRows(ordered, keep, ref);
    const threadType = rows.some((row) => row.thread_type === "portal_message") ? "portal_message" : keep.thread_type ?? "portal_message";
    actions.push({
      kind: "merge",
      keepId: keep.id,
      absorbIds: rows.filter((row) => row.id !== keep.id).map((row) => row.id),
      scope: keep.scope,
      ownerUserId: keep.owner_user_id,
      participantEmail: keep.participant_email,
      threadType,
      workspaceId: ref.workspaceId,
      key: ref.key,
      rowData: merged.rowData,
      turns: merged.turns,
    });
  }
  return { actions, skipped };
}

/** One printable line per action - the dry run's merge plan. */
export function describePlan(plan: BackfillPlan): string[] {
  const lines: string[] = [];
  for (const action of plan.actions) {
    if (action.kind === "merge") {
      lines.push(
        `MERGE  ${action.scope.replace("axis_portal_inbox_", "").replace("_v1", "")} owner=${action.ownerUserId ?? "-"} ws=${action.workspaceId.slice(0, 8)} key=${redactKey(action.key)}  keep=${action.keepId}  absorb=[${action.absorbIds.join(", ")}]  turns=${action.turns}`,
      );
    } else if (action.kind === "stamp") {
      lines.push(`STAMP  ${action.id}  ws=${action.workspaceId.slice(0, 8)} key=${redactKey(action.key)}`);
    } else {
      lines.push(`NOTICE ${action.id}  ws=${action.workspaceId.slice(0, 8)} key=${redactKey(action.key)}${action.flagged ? `  FLAGGED:${action.flagged.reason}` : ""}`);
    }
  }
  for (const skip of plan.skipped) lines.push(`SKIP   ${skip.id}  (${skip.reason})`);
  return lines;
}

/** Keys carry an email or a phone; the printed plan shows their shape, not the person. */
export function redactKey(key: string): string {
  const [kind, ...rest] = key.split(":");
  const value = rest.join(":");
  if (kind === "mail") {
    const [local = "", domain = ""] = value.split("@");
    return `mail:${local.slice(0, 1)}***@${domain}`;
  }
  if (kind === "tel") return `tel:${value.slice(0, 2)}******${value.slice(-2)}`;
  if (kind === "acct") return `acct:${value.slice(0, 8)}`;
  if (kind === "ws") return `ws:${value.slice(0, 8)}`;
  return key;
}
