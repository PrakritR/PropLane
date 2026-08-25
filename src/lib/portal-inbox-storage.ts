import { isDemoModeActive } from "@/lib/demo/demo-session";
import { formatPacificDateTime } from "@/lib/pacific-time";
import { notePortalResponse, portalSessionEnded } from "@/lib/auth/portal-session-gate";
/** Persist portal inbox threads (demo localStorage) so actions survive navigation and reloads. */

export type InboxThreadMessage = {
  id: string;
  from: string;
  body: string;
  at: string;
  /**
   * Direction hint from the owner's point of view. Absent on legacy rows and on
   * reply-appended messages (which are always the owner's own outbound replies),
   * where the index heuristic in the bubble builders is correct. Set explicitly
   * when a NEW message is appended to a person-thread so the recipient's inbox
   * copy renders inbound turns as inbound instead of assuming every non-root
   * message is the owner's reply.
   */
  outbound?: boolean;
  /** Optimistic send lifecycle — cleared after server sync. */
  delivery?: "sending" | "sent" | "failed";
  /** Image attachments served via /api/portal/inbox-attachments. */
  attachments?: { url: string; name?: string }[];
};

/**
 * An AI-drafted manager reply awaiting explicit manager approval. Stored ONLY on
 * the manager's own inbox thread row (owner-scoped to the manager), so it is
 * structurally invisible to the resident — residents read their own scope and
 * never this row. Nothing here is ever delivered to a resident until the manager
 * hits Approve & Send, which routes through the normal send path. See
 * `docs/agents/inbox-ai-drafts.md`.
 */
export type InboxAiDraft = {
  text: string;
  /** Only value while stored; approved/discarded drafts are removed, not restatused. */
  status: "pending_approval";
  generatedAt: string;
  model?: string;
};

export type PersistedInboxThread = {
  id: string;
  folder: "inbox" | "sent" | "trash";
  previousFolder?: "inbox" | "sent";
  from: string;
  email: string;
  subject: string;
  preview: string;
  body: string;
  time: string;
  unread: boolean;
  /** When true, the root turn renders as the owner's outbound message in inbox threads. */
  rootOutbound?: boolean;
  /** Root-turn attachments when the thread was opened with media. */
  attachments?: { url: string; name?: string }[];
  messages?: InboxThreadMessage[];
  /** Manager-only pending AI reply draft (never present on resident-scope rows). */
  aiDraft?: InboxAiDraft;
};

export const MANAGER_INBOX_STORAGE_KEY = "axis_portal_inbox_manager_v1";
export const RESIDENT_INBOX_STORAGE_KEY = "axis_portal_inbox_resident_v1";
export const VENDOR_INBOX_STORAGE_KEY = "axis_portal_inbox_vendor_v1";

/** Fired after `persistInbox` writes (same tab). `detail.key` is the storage key. */
export const PORTAL_INBOX_CHANGED_EVENT = "axis-portal-inbox-changed";
const memoryByKey = new Map<string, PersistedInboxThread[]>();
const inboxLastSyncedAtByKey = new Map<string, number>();
const inboxSyncPromiseByKey = new Map<string, Promise<PersistedInboxThread[]>>();
const PORTAL_INBOX_SYNC_TTL_MS = 15_000;
let inboxMutationDepth = 0;

/** True while a trash/restore/delete/reply mutation is in flight — blocks stale full replace syncs. */
export function inboxMutationInFlight(): boolean {
  return inboxMutationDepth > 0;
}

export function beginInboxMutation(): void {
  inboxMutationDepth += 1;
}

export function endInboxMutation(): void {
  inboxMutationDepth = Math.max(0, inboxMutationDepth - 1);
}

/** Commit inbox rows to memory/session immediately (before async server writes). */
export function stagePersistedInboxRows(key: string, threads: PersistedInboxThread[]): void {
  commitInboxMemory(key, threads);
}

export async function runInboxMutation<T>(fn: () => Promise<T>): Promise<T> {
  beginInboxMutation();
  try {
    return await fn();
  } finally {
    endInboxMutation();
  }
}

function inboxRowsChanged(a: PersistedInboxThread[], b: PersistedInboxThread[]) {
  return JSON.stringify(a) !== JSON.stringify(b);
}

function canUse(): boolean {
  return typeof window !== "undefined";
}

function sessionKeyForInbox(key: string) {
  return `axis:portal-inbox:${key}`;
}

function hydrateInboxFromSession(key: string) {
  if (!canUse() || memoryByKey.has(key)) return;
  try {
    const raw = window.sessionStorage.getItem(sessionKeyForInbox(key));
    if (!raw) return;
    const parsed = JSON.parse(raw) as PersistedInboxThread[];
    if (!Array.isArray(parsed)) return;
    memoryByKey.set(key, parsed.filter(looksLikeThread));
  } catch {
    /* ignore */
  }
}

function persistInboxToSession(key: string, rows: PersistedInboxThread[]) {
  if (!canUse()) return;
  try {
    window.sessionStorage.setItem(sessionKeyForInbox(key), JSON.stringify(rows));
  } catch {
    /* ignore */
  }
}

function looksLikeThread(row: unknown): row is PersistedInboxThread {
  if (!row || typeof row !== "object") return false;
  const r = row as Record<string, unknown>;
  return typeof r.id === "string" && typeof r.folder === "string";
}

/** Prefer local trash/restore state when server sync is stale (e.g. tab remount before persist completes). */
export function mergeInboxRowsWithLocalTrash(
  serverRows: PersistedInboxThread[],
  localRows: PersistedInboxThread[],
  opts?: { excludeIds?: Set<string> },
): PersistedInboxThread[] {
  const excludeIds = opts?.excludeIds ?? new Set<string>();
  const localById = new Map(localRows.map((row) => [row.id, row]));
  const serverIds = new Set(serverRows.map((row) => row.id));
  const merged = serverRows
    .filter((row) => !excludeIds.has(row.id))
    .map((serverRow) => {
      const localRow = localById.get(serverRow.id);
      if (!localRow) return serverRow;
      if (localRow.folder === "trash" && serverRow.folder !== "trash") {
        return {
          ...serverRow,
          folder: "trash" as const,
          previousFolder: localRow.previousFolder,
          unread: false,
        };
      }
      if (localRow.folder !== "trash" && serverRow.folder === "trash") {
        return { ...serverRow, folder: localRow.folder, previousFolder: undefined, unread: localRow.unread };
      }
      return serverRow;
    });
  for (const localRow of localRows) {
    if (excludeIds.has(localRow.id) || serverIds.has(localRow.id)) continue;
    merged.push(localRow);
  }
  return merged;
}

/** Unopened count for KPIs / badges (matches inbox tab filters). */
export function countUnopenedPersistedInbox(key: string, fallback: PersistedInboxThread[]): number {
  return loadPersistedInbox(key, fallback).filter((t) => t.folder === "inbox" && t.unread).length;
}

export async function syncPersistedInboxFromServer(
  key: string,
  opts?: { force?: boolean; excludeIds?: Set<string> },
): Promise<PersistedInboxThread[]> {
  if (!canUse()) return [];
  hydrateInboxFromSession(key);
  if (isDemoModeActive()) return memoryByKey.get(key) ?? [];
  // Signed out: stop the interval-driven refetch instead of 401ing forever.
  if (portalSessionEnded()) return memoryByKey.get(key) ?? [];
  const force = opts?.force === true;
  const inflight = inboxSyncPromiseByKey.get(key);
  if (!force && inflight) return inflight;
  const lastSyncedAt = inboxLastSyncedAtByKey.get(key) ?? 0;
  if (!force && lastSyncedAt > 0 && Date.now() - lastSyncedAt < PORTAL_INBOX_SYNC_TTL_MS) {
    return memoryByKey.get(key) ?? [];
  }
  const promise = (async () => {
    const res = await fetch(`/api/portal-inbox-threads?scope=${encodeURIComponent(key)}`, { credentials: "include", cache: "no-store" });
    notePortalResponse(res.status);
    if (!res.ok) return memoryByKey.get(key) ?? [];
    const body = (await res.json()) as { rows?: PersistedInboxThread[] };
    const rows = (Array.isArray(body.rows) ? body.rows : []).filter(looksLikeThread);
    const existing = memoryByKey.get(key) ?? [];
    const merged = mergeInboxRowsWithLocalTrash(rows, existing, { excludeIds: opts?.excludeIds });
    const collapsed =
      key === MANAGER_INBOX_STORAGE_KEY
        ? collapsePersonInboxThreads(merged, { mergeFolders: true })
        : merged;
    memoryByKey.set(key, collapsed);
    persistInboxToSession(key, collapsed);
    inboxLastSyncedAtByKey.set(key, Date.now());
    if (inboxRowsChanged(existing, collapsed)) {
      window.dispatchEvent(new CustomEvent<{ key: string }>(PORTAL_INBOX_CHANGED_EVENT, { detail: { key } }));
    }
    return collapsed;
  })();
  inboxSyncPromiseByKey.set(key, promise);
  try {
    return await promise;
  } finally {
    inboxSyncPromiseByKey.delete(key);
  }
}

/** Load inbox JSON or return fallback when missing / invalid. */
export function loadPersistedInbox(key: string, fallback: PersistedInboxThread[]): PersistedInboxThread[] {
  if (!canUse()) return fallback;
  hydrateInboxFromSession(key);
  if (memoryByKey.has(key)) {
    const rows = memoryByKey.get(key) ?? [];
    return key === MANAGER_INBOX_STORAGE_KEY
      ? collapsePersonInboxThreads(rows, { mergeFolders: true })
      : rows;
  }
  void syncPersistedInboxFromServer(key).catch(() => undefined);
  return fallback;
}

/** Permanently delete inbox thread rows from the server. */
export async function deleteInboxThreadIds(ids: string[]): Promise<boolean> {
  const clean = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  if (!canUse() || clean.length === 0) return true;
  // Demo sandbox is local-only: pretend the server delete succeeded.
  if (isDemoModeActive()) return true;
  try {
    const res = await fetch("/api/portal-inbox-threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ action: "deleteIds", ids: clean }),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean };
    return res.ok && data.ok !== false;
  } catch {
    return false;
  }
}

/** Clear cached inbox rows so the next sync always refetches from the server. */
export function invalidatePersistedInboxCache(key: string): void {
  if (!canUse()) return;
  inboxLastSyncedAtByKey.set(key, 0);
}

async function postInboxRows(
  action: "replace" | "upsert",
  key: string,
  rows: PersistedInboxThread[],
): Promise<boolean> {
  // Demo sandbox is local-only: pretend the server write succeeded.
  if (isDemoModeActive()) return true;
  try {
    const res = await fetch("/api/portal-inbox-threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(
        action === "replace"
          ? { action, rows: rows.map((thread) => ({ ...thread, scope: key })) }
          : { action, row: { ...rows[0]!, scope: key } },
      ),
    });
    if (!res.ok) return false;
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    return data.ok !== false;
  } catch {
    return false;
  }
}

function commitInboxMemory(key: string, threads: PersistedInboxThread[]): void {
  memoryByKey.set(key, threads);
  persistInboxToSession(key, threads);
  inboxLastSyncedAtByKey.set(key, Date.now());
  if (canUse()) {
    window.dispatchEvent(new CustomEvent<{ key: string }>(PORTAL_INBOX_CHANGED_EVENT, { detail: { key } }));
  }
}

/** Upsert one or more changed rows without deleting threads missing from the payload. */
export async function upsertPersistedInboxRows(
  key: string,
  changedRows: PersistedInboxThread[],
  allRows: PersistedInboxThread[],
): Promise<boolean> {
  if (!canUse() || changedRows.length === 0) return false;
  commitInboxMemory(key, allRows);
  for (const row of changedRows) {
    const ok = await postInboxRows("upsert", key, [row]);
    if (!ok) return false;
  }
  return true;
}

export async function persistInboxAwait(key: string, threads: PersistedInboxThread[]): Promise<boolean> {
  if (!canUse()) return false;
  const existing = memoryByKey.get(key) ?? [];
  const newIds = new Set(threads.map((t) => t.id));
  const removedIds = existing.map((t) => t.id).filter((id) => !newIds.has(id));
  if (removedIds.length > 0) {
    const deleted = await deleteInboxThreadIds(removedIds);
    if (!deleted) return false;
  }
  commitInboxMemory(key, threads);
  return postInboxRows("replace", key, threads);
}

/** Demo seed: load inbox threads into the local store without server mirror. */
export function seedDemoInbox(key: string, threads: PersistedInboxThread[]): void {
  if (!canUse()) return;
  memoryByKey.set(key, threads);
  persistInboxToSession(key, threads);
  inboxLastSyncedAtByKey.set(key, Date.now());
  window.dispatchEvent(new CustomEvent<{ key: string }>(PORTAL_INBOX_CHANGED_EVENT, { detail: { key } }));
}

export function persistInbox(key: string, threads: PersistedInboxThread[]): void {
  if (!canUse() || inboxMutationInFlight()) return;
  const existing = memoryByKey.get(key) ?? [];
  if (!inboxRowsChanged(existing, threads)) return;
  const newIds = new Set(threads.map((t) => t.id));
  const removedIds = existing.map((t) => t.id).filter((id) => !newIds.has(id));
  memoryByKey.set(key, threads);
  persistInboxToSession(key, threads);
  inboxLastSyncedAtByKey.set(key, Date.now());
  window.dispatchEvent(new CustomEvent<{ key: string }>(PORTAL_INBOX_CHANGED_EVENT, { detail: { key } }));
  if (isDemoModeActive()) return;
  void (async () => {
    if (inboxMutationInFlight()) return;
    if (removedIds.length > 0) {
      const deleted = await deleteInboxThreadIds(removedIds);
      if (!deleted) return;
    }
    await fetch("/api/portal-inbox-threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ action: "replace", rows: threads.map((thread) => ({ ...thread, scope: key })) }),
    }).catch(() => undefined);
  })();
}

/** Append one thread and emit inbox-changed event for live UI refresh. */
export function appendPersistedInboxThread(key: string, thread: PersistedInboxThread, fallback: PersistedInboxThread[] = []): void {
  const rows = loadPersistedInbox(key, fallback);
  persistInbox(key, [thread, ...rows]);
}

/**
 * Parse a conversation stamp into epoch ms.
 *
 * Inbox rows store `time` as a LOCALE DISPLAY STRING, and the one written on
 * send (`portal-inbox-delivery.ts`) carries no year: "Aug 3, 5:31 PM".
 * `Date.parse` resolves that to **2001**, while an older row stamped with an
 * explicit year ("Jul 20, 2026") resolves to 2026 — so raw `Date.parse` sorted
 * every recent message ~25 years BELOW every dated one. That is what put
 * today's threads underneath July rows in the conversation list.
 *
 * Year-less stamps are therefore resolved against the current year, rolling
 * back one year when that would place them in the future (a Dec stamp read in
 * January). Returns null when there is nothing parseable to order on.
 */
export function parseInboxStampMs(value?: string | null, now: Date = new Date()): number | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  // ISO / already-unambiguous stamps carry their own year.
  if (/\d{4}/.test(raw)) {
    const parsed = Date.parse(raw);
    return Number.isNaN(parsed) ? null : parsed;
  }

  const withYear = Date.parse(`${raw} ${now.getFullYear()}`);
  if (Number.isNaN(withYear)) return null;
  // Tolerate a little clock skew before deciding a stamp is "next year".
  if (withYear - now.getTime() > 24 * 60 * 60 * 1000) {
    const previous = Date.parse(`${raw} ${now.getFullYear() - 1}`);
    return Number.isNaN(previous) ? withYear : previous;
  }
  return withYear;
}

/**
 * Newest-first sort key for a conversation row.
 *
 * Ordering follows the thread's LATEST ACTIVITY, not its creation. The thread
 * id embeds the creation epoch, so preferring it (as this once did) meant a
 * reply never floated its conversation to the top — the id it sorted on had
 * not changed. The id epoch is now only a last resort, for rows with no
 * usable stamp at all.
 *
 * One implementation for every portal inbox — manager, unified, vendor.
 */
export function inboxThreadSortMs(id: string, activityTime?: string | null): number {
  const fromActivity = parseInboxStampMs(activityTime);
  if (fromActivity !== null) return fromActivity;
  // Prefer a millisecond epoch; a bare 10-digit run also matches phone numbers
  // and second-epochs, which are ~1000x smaller and would sort to the bottom.
  const ms = String(id ?? "").match(/(\d{13,})/);
  if (ms) return parseInt(ms[1]!, 10);
  return 0;
}

/** PropLane system senders — never a real conversation counterparty. */
const INBOX_SYSTEM_COUNTERPARTY_EMAILS = new Set(["tours@axis.local"]);

/** Guest email embedded in a tour-request manager notification body. */
export function parseTourNotificationGuestEmail(body: string): string {
  const match = body.match(/Guest:\s*(?:[^\n(]+)?\(([^)\s]+@[^)\s]+)\)/i);
  return match?.[1]?.trim().toLowerCase() ?? "";
}

/** Stable resident/counterparty key for collapsing duplicate person-threads. */
export function inboxThreadCounterpartyEmail(
  thread: Pick<PersistedInboxThread, "email" | "from" | "body">,
): string {
  const email = String(thread.email ?? "").trim().toLowerCase();
  if (email.includes("@") && !INBOX_SYSTEM_COUNTERPARTY_EMAILS.has(email)) return email;
  const fromBody = parseTourNotificationGuestEmail(String(thread.body ?? ""));
  if (fromBody.includes("@")) return fromBody;
  const from = String(thread.from ?? "").trim().toLowerCase();
  if (from.includes("@")) return from;
  return email;
}

/** Whether a thread turn is outbound from the inbox owner's perspective. */
export function inboxMessageOutbound(
  message: InboxThreadMessage,
  index: number,
  folder: PersistedInboxThread["folder"],
): boolean {
  return message.outbound ?? (index === 0 ? folder === "sent" : true);
}

/**
 * True when an inbox-folder thread still needs a manager reply — the latest
 * turn is inbound and no manager outbound turn follows it. `messages` holds
 * both resident follow-ups (outbound: false) and manager replies (default
 * outbound), so a non-empty array does NOT mean the manager already answered.
 */
export function inboxThreadManagerReplyPending(
  thread: Pick<PersistedInboxThread, "folder" | "body" | "messages" | "rootOutbound">,
): boolean {
  if (thread.folder !== "inbox") return false;
  const turns = inboxThreadMessages(thread as PersistedInboxThread);
  if (turns.length === 0) return Boolean(thread.body?.trim());

  let lastInboundIndex = -1;
  for (let i = 0; i < turns.length; i++) {
    if (!inboxMessageOutbound(turns[i]!, i, thread.folder)) lastInboundIndex = i;
  }
  if (lastInboundIndex < 0) return false;

  for (let i = lastInboundIndex + 1; i < turns.length; i++) {
    if (inboxMessageOutbound(turns[i]!, i, thread.folder)) return false;
  }
  return true;
}

/** Resolve a collapsed person-thread id for deep-linking Communication from another surface. */
export function findCollapsedInboxThreadIdForEmail(
  storageKey: string,
  email: string,
  opts?: { mergeFolders?: boolean },
): string | null {
  const norm = email.trim().toLowerCase();
  if (!norm.includes("@")) return null;
  const rows = loadPersistedInbox(storageKey, []);
  const collapsed = collapsePersonInboxThreads(rows, {
    mergeFolders: opts?.mergeFolders ?? true,
  });
  return collapsed.find((thread) => inboxThreadCounterpartyEmail(thread) === norm)?.id ?? null;
}

export function inboxThreadMessages(thread: PersistedInboxThread): InboxThreadMessage[] {
  const rootId = `${thread.id}-root`;
  const root: InboxThreadMessage = {
    id: rootId,
    from: thread.from,
    body: thread.body,
    at: thread.time,
    ...(thread.rootOutbound ? { outbound: true } : {}),
    ...(thread.attachments?.length ? { attachments: thread.attachments } : {}),
  };
  // Merged person-threads can carry a prior thread's synthetic root in `messages`;
  // skip an exact id collision so the timeline never renders duplicate React keys.
  const extras = (thread.messages ?? []).filter((m) => m.id !== rootId);
  return [root, ...extras];
}

/**
 * The canonical conversation stamp: "Aug 3, 5:31 PM".
 *
 * This is the shape `portal-inbox-delivery.ts` writes on send, and therefore
 * the shape the conversation list's narrow time column is laid out for. Kept
 * pinned to en-US on purpose — the value is persisted and later re-parsed for
 * ordering, so it must not vary with the viewer's locale.
 *
 * Pinned to Pacific for the same reason. The stamp carries no timezone, and
 * the two writers do not share one: the delivery path runs server-side (UTC on
 * Vercel) while this one runs in the browser, so the SAME instant was stored as
 * two different stamps and `parseInboxStampMs` — which reads both as
 * viewer-local — let a server-delivered message outrank a client reply that
 * actually happened later, by up to the UTC offset. One zone for every writer
 * keeps ordering consistent. A stamp written where local time was not Pacific
 * now displays shifted by that offset, which is the point rather than a
 * regression.
 */
export function formatInboxStamp(value: Date): string {
  return formatPacificDateTime(value);
}

/** The exact shape {@link formatInboxStamp} produces: "Aug 3, 5:31 PM". */
const CANONICAL_INBOX_STAMP = /^[A-Za-z]{3} \d{1,2}, \d{1,2}:\d{2}\s?(AM|PM)$/;

/**
 * Re-render any stamp into {@link formatInboxStamp}. An unreadable stamp falls
 * back to now rather than to the raw string: the only caller is appending a
 * reply that is happening right now, so "now" is both accurate and orderable,
 * whereas storing an unparseable string would leave the thread unsortable.
 *
 * An already-canonical stamp passes through untouched. `parseInboxStampMs`
 * reads a stamp as viewer-local, so round-tripping one that was written in
 * Pacific would shift it by the viewer's offset — the very drift pinning the
 * zone exists to remove. Only a foreign shape (a raw `toLocaleString()`, which
 * really is viewer-local) needs converting.
 */
function normalizeInboxStamp(value: string): string {
  const raw = value.trim();
  if (CANONICAL_INBOX_STAMP.test(raw)) return raw;
  const ms = parseInboxStampMs(raw);
  return formatInboxStamp(ms === null ? new Date() : new Date(ms));
}

export function appendReplyToInboxThread(
  thread: PersistedInboxThread,
  reply: InboxThreadMessage,
): PersistedInboxThread {
  return {
    ...thread,
    messages: [...(thread.messages ?? []), reply],
    preview: reply.body.slice(0, 100).replace(/\n/g, " "),
    // Carry the reply's stamp onto the thread. Without this the row kept its
    // ORIGINAL date after a reply ("replied today, still reads Jul 20") and,
    // because the list orders on this field, never floated to the top.
    //
    // Normalized on the way in: every reply call site builds `at` with a bare
    // `new Date().toLocaleString()`, which renders "8/3/2026, 6:31:00 PM" —
    // a different, much longer shape than the canonical stamp the server
    // writes, and one a non-en locale renders as "3.8.2026, 18:31:00", which
    // `parseInboxStampMs` cannot order on. Normalizing here keeps the list's
    // narrow time column in one format and keeps the sort key readable,
    // without asking three call sites to remember the convention.
    ...(reply.at ? { time: normalizeInboxStamp(reply.at) } : {}),
    unread: false,
  };
}

/**
 * Collapse duplicate person-threads into one row for display. Payment reminders
 * and manual sends used to mint a fresh thread id per message; this merges their
 * message history without rewriting storage.
 */
export function collapsePersonInboxThreads(
  threads: PersistedInboxThread[],
  opts?: { mergeFolders?: boolean },
): PersistedInboxThread[] {
  const mergeFolders = opts?.mergeFolders === true;
  const solo: PersistedInboxThread[] = [];
  const groups = new Map<string, PersistedInboxThread[]>();

  for (const thread of threads) {
    const counterparty = inboxThreadCounterpartyEmail(thread);
    if (!counterparty.includes("@") || thread.folder === "trash") {
      solo.push(thread);
      continue;
    }
    const key = mergeFolders ? counterparty : `${thread.folder}:${counterparty}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(thread);
    groups.set(key, bucket);
  }

  const merged: PersistedInboxThread[] = [...solo];
  for (const group of groups.values()) {
    if (group.length <= 1) {
      merged.push(group[0]!);
      continue;
    }
    const sorted = [...group].sort(
      (a, b) => inboxThreadSortMs(a.id, a.time) - inboxThreadSortMs(b.id, b.time),
    );
    const canonical = sorted[sorted.length - 1]!;
    const allMessages: InboxThreadMessage[] = [];
    for (const th of sorted) {
      allMessages.push(...inboxThreadMessages(th));
    }
    const seenIds = new Set<string>();
    const ordered = allMessages.filter((m) => {
      if (seenIds.has(m.id)) return false;
      seenIds.add(m.id);
      return true;
    });
    const first = ordered[0];
    if (!first) {
      merged.push(canonical);
      continue;
    }
    const last = ordered[ordered.length - 1]!;
    const canonicalRootId = `${canonical.id}-root`;
    const messages = ordered.slice(1).map((m) =>
      m.id === canonicalRootId ? { ...m, id: `merged:${m.id}` } : m,
    );
    merged.push({
      ...canonical,
      body: first.body,
      from: first.from,
      time: canonical.time,
      preview: last.body.slice(0, 100).replace(/\n/g, " "),
      messages,
      unread: group.some((t) => t.unread),
    });
  }
  return merged;
}

/** Resolve the collapsed thread row for the open conversation (merged message history). */
export function resolveCollapsedInboxThread(
  expandedId: string | null,
  collapsed: PersistedInboxThread[],
  raw: PersistedInboxThread[],
): PersistedInboxThread | null {
  if (!expandedId) return null;
  const direct = collapsed.find((t) => t.id === expandedId);
  if (direct) return direct;
  const legacy = raw.find((t) => t.id === expandedId);
  if (!legacy) return null;
  const counterparty = inboxThreadCounterpartyEmail(legacy);
  if (!counterparty.includes("@")) return legacy;
  return (
    collapsed.find((t) => inboxThreadCounterpartyEmail(t) === counterparty) ?? legacy
  );
}
