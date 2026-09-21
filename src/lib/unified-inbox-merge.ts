/** Shared types for email + SMS rows in one Communication inbox list. */

import type { RecordKind } from "@/lib/portals/record-kinds";

export type UnifiedInboxChannel = "email" | "sms";

export type CommunicationListSort = "recent" | "resident";

export type UnifiedInboxListItem = {
  /** Stable list key, e.g. `email:thread-id` or `sms:conversation-key`. */
  key: string;
  channel: UnifiedInboxChannel;
  threadId: string;
  name: string;
  subtitle?: string;
  preview: string;
  previewPrefix?: string;
  time: string;
  unread: boolean;
  /** Milliseconds since epoch for sort (higher = newer). */
  sortMs: number;
  /**
   * WHO this conversation is with, normalized (lowercased email today). Rows
   * that agree here are the same human reached on different channels and
   * collapse into one conversation. Absent means "we do not know who this is" —
   * an unknown texter, say — and such a row NEVER merges, because guessing a
   * stranger's number onto a resident would show their messages, and the
   * manager's replies, to the wrong person.
   */
  personKey?: string;
  /**
   * Every channel folded into this row, newest first. Length > 1 means the row
   * is a merge and the UI should say so.
   */
  channels?: UnifiedInboxChannel[];
  /**
   * Every list key collapsed into this row, including its own. A merged row
   * spans several stored threads, and anything that acts on "this conversation"
   * (selection, delete) has to cover all of them rather than the winner alone.
   */
  memberKeys?: string[];
  /** Email address behind {@link personKey}, when the row has one. */
  personEmail?: string;
  /** House this conversation is about. Omitted when it cannot be resolved. */
  address?: string;
  /** Tour / Payments / Maintenance / … Omitted when the source recorded none. */
  category?: string;
  /** Unread inbound turns. Only meaningful while `unread` is true. */
  unreadCount?: number;
  readSources?: { id: string; observation: string; unread?: boolean }[];
  /** All folded members have a non-conflicting GET observation. */
  readSourcesComplete?: boolean;
  /** Exact server-returned native conversation binding, when present. */
  smsBindingKey?: string;
  /**
   * All exact native bindings declared by selected authorized email sources.
   * A non-empty set - including a conflict - forbids email fallback.
   */
  smsBindingKeys?: string[];
  /** The record this thread is about (`PersistedInboxThread.recordRef`), when it has one. */
  recordRef?: { kind: RecordKind; id: string; label: string };
};

export function sortUnifiedInboxItems(
  items: UnifiedInboxListItem[],
  mode: CommunicationListSort = "recent",
): UnifiedInboxListItem[] {
  const copy = [...items];
  if (mode === "resident") {
    return copy.sort(
      (a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || b.sortMs - a.sortMs,
    );
  }
  return copy.sort((a, b) => b.sortMs - a.sortMs);
}

/** Normalized identity for cross-channel matching; empty input never matches. */
export function unifiedInboxPersonKey(email: string | null | undefined): string | undefined {
  const trimmed = String(email ?? "").trim().toLowerCase();
  return trimmed.includes("@") ? trimmed : undefined;
}

export function unifiedInboxSmsBindingKey(conversationKey: string | null | undefined): string | undefined {
  const key = String(conversationKey ?? "").trim();
  return key ? `sms-conversation:${key}` : undefined;
}

/**
 * Collapse rows that reach the SAME person onto one conversation, then sort.
 *
 * A resident with an email thread and a text thread used to occupy two rows,
 * because the list keyed on the channel's own thread id and nothing said the
 * two belonged to one human. Rows sharing a `personKey` now merge: the newest
 * contributor supplies what the row shows (preview, stamp, sort position), the
 * row is unread if ANY channel is, and `channels` / `memberKeys` carry what was
 * folded in so the thread pane and any destructive action can address all of
 * it. Rows with no `personKey` are passed through untouched.
 */
export function mergeUnifiedInboxItems(
  items: UnifiedInboxListItem[],
  sort: CommunicationListSort = "recent",
): UnifiedInboxListItem[] {
  const groups = new Map<string, UnifiedInboxListItem[]>();
  const loners: UnifiedInboxListItem[] = [];

  for (const item of items) {
    const person = item.personKey;
    if (!person) {
      loners.push(item);
      continue;
    }
    const bucket = groups.get(person);
    if (bucket) bucket.push(item);
    else groups.set(person, [item]);
  }

  const merged: UnifiedInboxListItem[] = [];
  for (const bucket of groups.values()) {
    const explicitBindings = new Set(
      bucket
        .filter((row) => (row.channels ?? [row.channel]).includes("email"))
        .flatMap((row) => [
          ...(row.smsBindingKeys ?? []),
          row.smsBindingKey ?? "",
        ])
        .map((key) => key.trim())
        .filter(Boolean),
    );
    // An old or already-collapsed caller may still group a same-email native
    // row under an explicitly bound email source. Keep only actual declared
    // native keys in that conversation. The rejected row remains a separate
    // conversation rather than becoming selected/displayed by email fallback.
    const accepted = explicitBindings.size === 0
      ? bucket
      : bucket.filter((row) => {
          const channels = row.channels ?? [row.channel];
          if (channels.includes("email")) return true;
          if (!channels.includes("sms")) return true;
          const nativeKeys = [row.smsBindingKey ?? "", row.threadId]
            .map((key) => key.trim())
            .filter(Boolean);
          return nativeKeys.some((key) => explicitBindings.has(key));
        });
    const rejected = accepted.length === bucket.length
      ? []
      : bucket.filter((row) => !accepted.includes(row));
    merged.push(...rejected);
    if (accepted.length === 1) {
      merged.push(accepted[0]!);
      continue;
    }
    // Newest first: the winner is the conversation the manager last touched, so
    // the row reads like the most recent thing that actually happened.
    const ordered = [...accepted].sort((a, b) => b.sortMs - a.sortMs);
    const [winner, ...rest] = ordered as [UnifiedInboxListItem, ...UnifiedInboxListItem[]];
    const channels: UnifiedInboxChannel[] = [];
    for (const row of ordered) {
      for (const channel of row.channels ?? [row.channel]) {
        if (!channels.includes(channel)) channels.push(channel);
      }
    }
    merged.push({
      ...winner,
      // A name is often only known on one side (SMS carries the directory name,
      // email may carry only the address), so prefer any real name over one
      // that is just the address again.
      name: pickDisplayName(ordered),
      subtitle: ordered.find((row) => row.subtitle?.trim())?.subtitle,
      unread: ordered.some((row) => row.unread),
      channels,
      memberKeys: dedupe([
        ...(winner.memberKeys ?? [winner.key]),
        ...rest.flatMap((row) => row.memberKeys ?? [row.key]),
      ]),
      ...mergeReadSourceState(ordered),
      smsBindingKey: winner.smsBindingKey ?? ordered.find((row) => row.smsBindingKey)?.smsBindingKey,
      ...(mergeSmsBindingKeys(ordered).length > 0
        ? { smsBindingKeys: mergeSmsBindingKeys(ordered) }
        : {}),
      personEmail: winner.personEmail ?? ordered.find((row) => row.personEmail)?.personEmail,
      // Meta is known on whichever side recorded it, so take the first that has
      // one rather than the winner's blank.
      address: winner.address ?? ordered.find((row) => row.address)?.address,
      category: winner.category ?? ordered.find((row) => row.category)?.category,
      recordRef: winner.recordRef ?? ordered.find((row) => row.recordRef)?.recordRef,
      // A merged row is one conversation, so its unread badge is the total
      // across the channels folded into it.
      unreadCount: ordered.reduce((sum, row) => sum + (row.unreadCount ?? 0), 0) || undefined,
    });
  }

  return sortUnifiedInboxItems([...merged, ...loners], sort);
}

function dedupe(values: string[]): string[] {
  return values.filter((value, index) => value && values.indexOf(value) === index);
}

function mergeReadSourceState(rows: UnifiedInboxListItem[]): Pick<UnifiedInboxListItem, "readSources" | "readSourcesComplete"> {
  // Native SMS has its own local receipt store. It intentionally carries no
  // email observation, so it must not make an otherwise complete email
  // acknowledgement ineligible. A zero-email SMS-only row is complete but
  // has no sources to POST.
  const emailRows = rows.filter((row) => (row.channels ?? [row.channel]).includes("email"));
  if (emailRows.length === 0) return { readSources: [], readSourcesComplete: true };
  if (emailRows.some((row) => row.readSourcesComplete !== true || !(row.readSources?.length))) return { readSources: [], readSourcesComplete: false };
  const readSources = mergeReadSources(emailRows.flatMap((row) => row.readSources ?? []));
  return { readSources, readSourcesComplete: readSources.length > 0 };
}

function mergeReadSources(sources: { id: string; observation: string; unread?: boolean }[]) {
  const byId = new Map<string, { observation: string; unread?: boolean }>();
  for (const source of sources) {
    const previous = byId.get(source.id);
    if (previous && (previous.observation !== source.observation || (previous.unread !== undefined && source.unread !== undefined && previous.unread !== source.unread))) return [];
    byId.set(source.id, { observation: source.observation, unread: previous?.unread ?? source.unread });
  }
  return [...byId].map(([id, source]) => ({ id, ...source }));
}

function mergeSmsBindingKeys(rows: UnifiedInboxListItem[]): string[] {
  return [...new Set(
    rows.flatMap((row) => [
      ...(row.smsBindingKeys ?? []),
      (row.channels ?? [row.channel]).includes("email") ? row.smsBindingKey ?? "" : "",
    ])
      .map((key) => key.trim())
      .filter(Boolean),
  )];
}

/**
 * The most human label available. A row whose name IS its email address tells
 * the manager nothing they cannot already see, so a real name from any
 * contributing channel wins over it.
 */
function pickDisplayName(rows: UnifiedInboxListItem[]): string {
  const named = rows.find((row) => {
    const name = row.name.trim();
    if (!name) return false;
    return !name.includes("@") && name !== row.personKey;
  });
  return (named ?? rows[0]!).name;
}

export function parseUnifiedInboxKey(key: string): { channel: UnifiedInboxChannel; threadId: string } | null {
  const idx = key.indexOf(":");
  if (idx <= 0) return null;
  const channel = key.slice(0, idx);
  if (channel !== "email" && channel !== "sms") return null;
  const threadId = key.slice(idx + 1);
  if (!threadId) return null;
  return { channel, threadId };
}

export function unifiedInboxKey(channel: UnifiedInboxChannel, threadId: string): string {
  return `${channel}:${threadId}`;
}

/** Filter SMS rows to match email folder tabs where it makes sense. */
export function smsItemMatchesInboxTab(
  tabId: string,
  item: UnifiedInboxListItem,
  opts?: { lastOutbound?: boolean },
): boolean {
  if (item.channel !== "sms") return false;
  if (tabId === "trash" || tabId === "schedule") return false;
  if (tabId === "sent") return Boolean(opts?.lastOutbound);
  if (tabId === "unopened") return item.unread;
  if (tabId === "opened") return !item.unread;
  return true;
}
