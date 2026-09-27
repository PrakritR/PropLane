import { smsNoticeIdentity } from "@/lib/sms-inbox-identity";
import {
  assistantInboxCollapseKey,
  boundManagerUserIdFromThread,
  canonicalResidentAgentThreadId,
} from "@/lib/communication-inbox-assistant";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { RESIDENT_AGENT_FROM_NAME } from "@/lib/agent/resident-inbox-agent-ids";
import { formatPacificDateTime } from "@/lib/pacific-time";
import {
  notePortalResponse,
  onPortalSessionViewerChange,
  portalSessionEnded,
  portalSessionViewerId,
} from "@/lib/auth/portal-session-gate";
import { trimmedText } from "@/lib/trimmed-text";
import { normalizeRecordRef, type RecordRef } from "@/lib/portals/record-kinds";
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
  /**
   * The channel this turn actually travelled on. Stamped by whichever path
   * wrote the message (email mirror, SMS delivery, portal reply); absent on
   * rows written before stamping existed. A missing stamp means "unknown" —
   * it is never read as email, which is how an in-app reply used to wear an
   * EMAIL tag while nothing had been sent.
   */
  channel?: InboxThreadMessageChannel;
  /**
   * The email subject this turn arrived or left with. Only email turns carry
   * one; the bubble shows it when it is the thread's first subject or differs
   * from the previous email turn's.
   */
  subject?: string;
};

export type InboxThreadMessageChannel = "email" | "sms" | "proplane";

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
  /**
   * A draft the workspace's draft-for-review setting queued (WS5): the
   * manager must approve it by hand. The inbox's AI auto-send latch skips it —
   * auto-sending would be the exact opposite of what the setting promises.
   */
  requiresReview?: boolean;
  /** `automation:<domain>:<event>` for a queued automation draft; absent on an AI reply draft. */
  origin?: string;
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
  rootAt?: string;
  /** Channel / email subject of the root turn — the root lives in `body`, so its stamps live here. */
  rootChannel?: InboxThreadMessageChannel;
  rootSubject?: string;
  /** Root-turn attachments when the thread was opened with media. */
  attachments?: { url: string; name?: string }[];
  messages?: InboxThreadMessage[];
  /** Manager-only pending AI reply draft (never present on resident-scope rows). */
  aiDraft?: InboxAiDraft;
  /**
   * Drafts waiting behind `aiDraft`, oldest first. A second automated draft
   * for the same person never overwrites one still pending approval; it
   * queues here and is promoted by {@link advanceInboxAiDraft} once the head
   * is approved or discarded.
   */
  aiDraftQueue?: InboxAiDraft[];
  /**
   * `generatedAt` of every draft this browser approved or discarded on the
   * thread. A shared (team) thread's draft slots are server-authoritative:
   * the mailbox merge removes exactly these and keeps everything else, so a
   * stale snapshot can never wipe a draft the viewer never saw.
   */
  resolvedAiDraftIds?: string[];
  /**
   * What the conversation is about, stamped by the send path (see
   * `deliverPortalInboxMessage`'s `eventCategory`). ABSENT on every row written
   * before that stamp existed — an absent category renders no chip, never a
   * guess from the subject line.
   */
  category?: string;
  /** Server thread_type when the row still carries it (resident_agent / vendor_agent). */
  threadType?: string | null;
  thread_type?: string | null;
  /** Resident assistant: which manager's tools this thread is bound to. */
  boundManagerUserId?: string;
  /** Server-verified SMS conversation identity for exact cross-channel folding. */
  smsConversationKey?: string;
  ownerUserId?: string;
  smsNoticePhone?: string;
  sourceThreadIds?: string[];
  /** Response-only server observations for metadata-only viewed acknowledgements. */
  readSources?: {
    id: string;
    observation: string;
    /** Confirmed unread truth from the exact GET observation. */
    unread?: boolean;
    /** A client-only, operation-owned overlay. It never becomes confirmed truth. */
    optimistic?: { token: string; unread: boolean };
  }[];
  /** True only when every folded member supplied one non-conflicting GET observation. */
  readSourcesComplete?: boolean;
  /**
   * Exact native bindings declared by the authorized email source records.
   * This is response-only provenance: an empty/absent value means no source
   * declared a binding, while one or more keys prohibit email fallback.
   */
  smsBindingKeys?: string[];
  /**
   * Response-only: the house(s) the server resolved this thread to be about
   * (`conversation-visibility.server.ts`). The list labels the row with the
   * first one; visibility was already decided with the same set.
   */
  houses?: { propertyId: string; label: string }[];
  /**
   * What RECORD this thread is about — a property, a charge, a lease, a
   * service request, and so on — stamped by the send path when the caller
   * composed from inside that record's Communication section (see
   * `docs/agents/communication-inbox.md` § `recordRef`). It is a LABEL on the
   * thread for display and filtering, never an authorization grant: every
   * send still authorizes the recipient first and appends second, exactly as
   * every other send does. A thread written before this existed carries none
   * and renders no chip — never a guessed one.
   */
  recordRef?: RecordRef;
};

export const MANAGER_INBOX_STORAGE_KEY = "axis_portal_inbox_manager_v1";
export const RESIDENT_INBOX_STORAGE_KEY = "axis_portal_inbox_resident_v1";
export const VENDOR_INBOX_STORAGE_KEY = "axis_portal_inbox_vendor_v1";

/** Fired after `persistInbox` writes (same tab). `detail.key` is the storage key. */
export const PORTAL_INBOX_CHANGED_EVENT = "axis-portal-inbox-changed";
const memoryByKey = new Map<string, PersistedInboxThread[]>();
const inboxSuccessfulServerSyncAtByKey = new Map<string, number>();

export type PersistedInboxSyncResult = {
  rows: PersistedInboxThread[];
  /** Only a current viewer's completed server response is ready for an initial list. */
  ok: boolean;
  /** A request that belonged to an older auth generation must never publish. */
  stale?: boolean;
};

const inboxSyncPromiseByKey = new Map<string, Promise<PersistedInboxSyncResult>>();
let inboxViewerGeneration = 0;

/**
 * Every cache in this module is keyed by the VIEWER as well as the inbox scope.
 *
 * The scope string (`axis_portal_inbox_manager_v1`) is identical for every
 * manager, so keying on it alone made the module-global map and the
 * `sessionStorage` mirror shared state between accounts: sign out, sign in as
 * somebody else in the same tab, and `loadPersistedInbox` returned the previous
 * account's threads SYNCHRONOUSLY, before any fetch could correct them. The
 * server route was always scoped by `owner_user_id` / `participant_email` — the
 * leak was purely this cache. Never key these maps on the bare scope again.
 *
 * A null viewer (session not resolved yet, or signed out) gets its own bucket
 * rather than sharing one, so an unauthenticated first paint can never be handed
 * a signed-in account's mail.
 */
function viewerCacheKey(key: string): string {
  return `${portalSessionViewerId() ?? "anon"}::${key}`;
}

/** Drop every cached row when the account changes, so nothing outlives a sign-out. */
function purgeInboxCaches(): void {
  inboxViewerGeneration += 1;
  memoryByKey.clear();
    inboxSuccessfulServerSyncAtByKey.clear();
  inboxSyncPromiseByKey.clear();
  if (!canUse()) return;
  try {
    const stale: string[] = [];
    for (let i = 0; i < window.sessionStorage.length; i += 1) {
      const storageKey = window.sessionStorage.key(i);
      if (storageKey?.startsWith(SESSION_KEY_PREFIX)) stale.push(storageKey);
    }
    for (const storageKey of stale) window.sessionStorage.removeItem(storageKey);
  } catch {
    /* ignore */
  }
}

if (typeof window !== "undefined") {
  onPortalSessionViewerChange(() => {
    purgeInboxCaches();
  });
}
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

const SESSION_KEY_PREFIX = "axis:portal-inbox:";

function sessionKeyForInbox(key: string) {
  return `${SESSION_KEY_PREFIX}${viewerCacheKey(key)}`;
}

function hydrateInboxFromSession(key: string) {
  if (!canUse() || memoryByKey.has(viewerCacheKey(key))) return;
  try {
    const raw = window.sessionStorage.getItem(sessionKeyForInbox(key));
    if (!raw) return;
    const parsed = JSON.parse(raw) as PersistedInboxThread[];
    if (!Array.isArray(parsed)) return;
    memoryByKey.set(viewerCacheKey(key), inboxThreadsFromUnknown(parsed));
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

/**
 * `row_data` JSON can store email/from as a number (the Communication
 * `x.trim is not a function` crash). Coerce identity fields to strings at the
 * load boundary so existing accounts keep their threads after a refresh.
 */
export function normalizePersistedInboxThread(thread: PersistedInboxThread): PersistedInboxThread {
  const smsBindingKeys = [...new Set(
    [...(Array.isArray(thread.smsBindingKeys) ? thread.smsBindingKeys : []), thread.smsConversationKey ?? ""]
      .filter((key): key is string => typeof key === "string")
      .map((key) => key.trim())
      .filter(Boolean),
  )];
  return {
    ...thread,
    from: trimmedText(thread.from) || String(thread.from ?? ""),
    email: trimmedText(thread.email),
    subject: trimmedText(thread.subject),
    preview: trimmedText(thread.preview),
    body: typeof thread.body === "string" ? thread.body : String(thread.body ?? ""),
    time: trimmedText(thread.time) || String(thread.time ?? ""),
    ...(smsBindingKeys.length > 0 ? { smsBindingKeys } : {}),
    // Malformed `recordRef` (bad kind, empty id/label) never renders a chip or
    // participates in filtering rather than crashing the list on a bad row.
    recordRef: normalizeRecordRef(thread.recordRef) ?? undefined,
  };
}

function inboxThreadsFromUnknown(rows: unknown): PersistedInboxThread[] {
  if (!Array.isArray(rows)) return [];
  return rows.filter(looksLikeThread).map(normalizePersistedInboxThread);
}

/** Prefer local trash/restore state when server sync is stale (e.g. tab remount before persist completes). */
export function mergeInboxRowsWithLocalTrash(
  serverRows: PersistedInboxThread[],
  localRows: PersistedInboxThread[],
  opts?: { excludeIds?: Set<string>; serverAuthoritative?: boolean },
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
  if (opts?.serverAuthoritative) return merged;
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

export async function syncPersistedInboxFromServerWithStatus(
  key: string,
  opts?: { force?: boolean; excludeIds?: Set<string> },
): Promise<PersistedInboxSyncResult> {
  if (!canUse()) return { rows: [], ok: false };
  hydrateInboxFromSession(key);
  const cacheKey = viewerCacheKey(key);
  const viewerGeneration = inboxViewerGeneration;
  const isCurrentRequest = () => viewerGeneration === inboxViewerGeneration && cacheKey === viewerCacheKey(key);
  if (isDemoModeActive()) return { rows: memoryByKey.get(cacheKey) ?? [], ok: true };
  // Signed out: stop the interval-driven refetch instead of 401ing forever.
  if (portalSessionEnded()) return { rows: memoryByKey.get(cacheKey) ?? [], ok: false };
  const force = opts?.force === true;
  const inflight = inboxSyncPromiseByKey.get(cacheKey);
  if (!force && inflight) return inflight;
  const successfulSyncAt = inboxSuccessfulServerSyncAtByKey.get(cacheKey) ?? 0;
  if (!force && successfulSyncAt > 0 && Date.now() - successfulSyncAt < PORTAL_INBOX_SYNC_TTL_MS) {
    return { rows: memoryByKey.get(cacheKey) ?? [], ok: true };
  }
  const promise = (async (): Promise<PersistedInboxSyncResult> => {
    try {
      const res = await fetch(`/api/portal-inbox-threads?scope=${encodeURIComponent(key)}`, { credentials: "include", cache: "no-store" });
      // An older viewer may complete after A -> B -> A. Do not let its 401
      // latch the new session or let any of its data touch the new cache slot.
      if (!isCurrentRequest()) return { rows: [], ok: false, stale: true };
      notePortalResponse(res.status);
      if (!res.ok) {
        inboxSuccessfulServerSyncAtByKey.delete(cacheKey);
        return { rows: memoryByKey.get(cacheKey) ?? [], ok: false };
      }
      const body = (await res.json()) as { rows?: PersistedInboxThread[] };
      if (!isCurrentRequest()) return { rows: [], ok: false, stale: true };
      if (!body || !Array.isArray(body.rows)) {
        inboxSuccessfulServerSyncAtByKey.delete(cacheKey);
        return { rows: memoryByKey.get(cacheKey) ?? [], ok: false };
      }
      const rows = inboxThreadsFromUnknown(body.rows);
      const existing = memoryByKey.get(cacheKey) ?? [];
      const merged = mergeInboxRowsWithLocalTrash(rows, existing, {
        excludeIds: opts?.excludeIds,
        serverAuthoritative: true,
      });
      const collapsed = applyInboxCollapseForScope(key, merged);
      memoryByKey.set(cacheKey, collapsed);
      persistInboxToSession(key, collapsed);
      const syncedAt = Date.now();
      inboxSuccessfulServerSyncAtByKey.set(cacheKey, syncedAt);
      if (inboxRowsChanged(existing, collapsed)) {
        window.dispatchEvent(new CustomEvent<{ key: string }>(PORTAL_INBOX_CHANGED_EVENT, { detail: { key } }));
      }
      return { rows: collapsed, ok: true };
    } catch {
      return isCurrentRequest()
        ? (inboxSuccessfulServerSyncAtByKey.delete(cacheKey), { rows: memoryByKey.get(cacheKey) ?? [], ok: false })
        : { rows: [], ok: false, stale: true };
    }
  })();
  inboxSyncPromiseByKey.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    // A force refresh can replace this entry. Never clear its newer promise.
    if (inboxSyncPromiseByKey.get(cacheKey) === promise) inboxSyncPromiseByKey.delete(cacheKey);
  }
}

/** Legacy array-only API for existing refresh consumers. */
export function persistedInboxReadSucceeded(key: string) {
  if (isDemoModeActive()) return true;
  const cacheKey = viewerCacheKey(key);
  const syncedAt = inboxSuccessfulServerSyncAtByKey.get(cacheKey) ?? 0;
  return syncedAt > 0 && Date.now() - syncedAt < PORTAL_INBOX_SYNC_TTL_MS;
}
export async function syncPersistedInboxFromServer(
  key: string,
  opts?: { force?: boolean; excludeIds?: Set<string> },
): Promise<PersistedInboxThread[]> {
  return (await syncPersistedInboxFromServerWithStatus(key, opts)).rows;
}

/** Load inbox JSON or return fallback when missing / invalid. */
export function loadPersistedInbox(key: string, fallback: PersistedInboxThread[]): PersistedInboxThread[] {
  if (!canUse()) return fallback;
  hydrateInboxFromSession(key);
  if (memoryByKey.has(viewerCacheKey(key))) {
    const rows = memoryByKey.get(viewerCacheKey(key)) ?? [];
    return applyInboxCollapseForScope(key, rows);
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
  const cacheKey = viewerCacheKey(key);
  inboxSuccessfulServerSyncAtByKey.set(cacheKey, 0);
}

/**
 * The manager<->manager Team thread (`team-comms.server.ts`) is shared by
 * several accounts and appended server-side under a CAS; the wholesale
 * `replace` a browser sends on every local change must never carry it, or a
 * stale snapshot overwrites turns others posted. Explicit single-row upserts
 * (approve / discard a draft, archive) still go, and the route merges only
 * that mailbox state.
 */
function isSharedTeamThread(thread: Pick<PersistedInboxThread, "id" | "threadType">): boolean {
  return thread.threadType === "team" || thread.id.startsWith("team-thread:");
}

async function postInboxRows(
  action: "replace" | "upsert",
  key: string,
  rows: PersistedInboxThread[],
): Promise<boolean> {
  const serialize = (thread: PersistedInboxThread) => {
    const {
      readSources: _readSources,
      readSourcesComplete: _readSourcesComplete,
      smsBindingKeys: _smsBindingKeys,
      ...stored
    } = thread;
    return { ...stored, scope: key };
  };
  // Demo sandbox is local-only: pretend the server write succeeded.
  if (isDemoModeActive()) return true;
  const replaceRows = action === "replace" ? rows.filter((row) => !isSharedTeamThread(row)) : rows;
  if (replaceRows.length === 0) return true;
  try {
    const res = await fetch("/api/portal-inbox-threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(
        action === "replace"
          ? { action, rows: replaceRows.map(serialize) }
          : { action, row: serialize(rows[0]!) },
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
  memoryByKey.set(viewerCacheKey(key), threads);
  persistInboxToSession(key, threads);
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

export async function changePersistedInboxThreadFolders(
  key: string,
  ids: string[],
  action: "archive" | "restore",
): Promise<boolean> {
  if (!canUse() || ids.length === 0) return false;
  if (isDemoModeActive()) return true;
  try {
    const res = await fetch("/api/portal-inbox-threads", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "changeFolder", scope: key, ids, folderAction: action }),
    });
    if (!res.ok) return false;
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean };
    return data.ok !== false;
  } catch {
    return false;
  }
}

export async function persistInboxAwait(key: string, threads: PersistedInboxThread[]): Promise<boolean> {
  if (!canUse()) return false;
  const existing = memoryByKey.get(viewerCacheKey(key)) ?? [];
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
  memoryByKey.set(viewerCacheKey(key), threads);
  persistInboxToSession(key, threads);
  window.dispatchEvent(new CustomEvent<{ key: string }>(PORTAL_INBOX_CHANGED_EVENT, { detail: { key } }));
}

export function persistInbox(key: string, threads: PersistedInboxThread[]): void {
  if (!canUse() || inboxMutationInFlight()) return;
  const existing = memoryByKey.get(viewerCacheKey(key)) ?? [];
  if (!inboxRowsChanged(existing, threads)) return;
  const newIds = new Set(threads.map((t) => t.id));
  const removedIds = existing.map((t) => t.id).filter((id) => !newIds.has(id));
  memoryByKey.set(viewerCacheKey(key), threads);
  persistInboxToSession(key, threads);
  window.dispatchEvent(new CustomEvent<{ key: string }>(PORTAL_INBOX_CHANGED_EVENT, { detail: { key } }));
  if (isDemoModeActive()) return;
  void (async () => {
    if (inboxMutationInFlight()) return;
    if (removedIds.length > 0) {
      const deleted = await deleteInboxThreadIds(removedIds);
      if (!deleted) return;
    }
    const storedRows = threads
      .filter((thread) => !isSharedTeamThread(thread))
      .map((thread) => {
        const {
          readSources: _readSources,
          readSourcesComplete: _readSourcesComplete,
          smsBindingKeys: _smsBindingKeys,
          ...stored
        } = thread;
        return { ...stored, scope: key };
      });
    if (storedRows.length === 0) return;
    await fetch("/api/portal-inbox-threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ action: "replace", rows: storedRows }),
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

/**
 * A system sender that STANDS IN for a real person, so the counterparty is
 * somebody else and has to be recovered from the body.
 *
 * Only tour notifications work this way: PropLane sends them, but the person the
 * manager is actually corresponding with is the guest named inside.
 */
const INBOX_SYSTEM_COUNTERPARTY_EMAILS = new Set(["tours@axis.local"]);

/**
 * PropLane's own addresses — where PropLane IS the counterparty.
 *
 * These are not stand-ins for anyone, so they all resolve to one key and their
 * threads collapse into a single PropLane conversation. Each address used to key
 * its own thread, which is why the inbox showed a stack of near-identical
 * PropLane rows with no way to tell them apart (PRP-150).
 *
 * Matching is by LOCAL PART on the PropLane system domain rather than a literal
 * list, so a notification sent from a new `something@axis.local` joins the same
 * thread instead of starting the pile over.
 */
const PROPLANE_SYSTEM_SENDER_DOMAIN = "axis.local";

/** The one counterparty key every PropLane system thread collapses onto. */
export const PROPLANE_SYSTEM_COUNTERPARTY_KEY = "proplane@axis.local";

/** True for a PropLane system address that speaks for PropLane itself. */
export function isProplaneSystemSenderEmail(raw: string | null | undefined): boolean {
  const email = String(raw ?? "").trim().toLowerCase();
  if (!email.endsWith(`@${PROPLANE_SYSTEM_SENDER_DOMAIN}`)) return false;
  // A tour notification is PropLane's address but the guest's conversation, so
  // it is deliberately not one of these.
  return !INBOX_SYSTEM_COUNTERPARTY_EMAILS.has(email);
}

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
  // Every PropLane system address is the SAME counterparty — PropLane — so they
  // share one key and one thread (PRP-150).
  if (isProplaneSystemSenderEmail(email)) return PROPLANE_SYSTEM_COUNTERPARTY_KEY;
  if (email.includes("@") && !INBOX_SYSTEM_COUNTERPARTY_EMAILS.has(email)) return email;
  const fromBody = parseTourNotificationGuestEmail(String(thread.body ?? ""));
  if (fromBody.includes("@")) return fromBody;
  const from = String(thread.from ?? "").trim().toLowerCase();
  if (isProplaneSystemSenderEmail(from)) return PROPLANE_SYSTEM_COUNTERPARTY_KEY;
  if (from.includes("@")) return from;
  return email;
}

/**
 * The thread once its pending draft is approved or discarded: the next queued
 * draft (if any) becomes `aiDraft`, so an automated draft that arrived while
 * an earlier one was still waiting is never lost.
 */
export function advanceInboxAiDraft<
  T extends Pick<PersistedInboxThread, "aiDraft" | "aiDraftQueue" | "resolvedAiDraftIds">,
>(thread: T): T {
  const queue = Array.isArray(thread.aiDraftQueue) ? thread.aiDraftQueue.filter(Boolean) : [];
  const [next, ...rest] = queue;
  const resolvedId = thread.aiDraft?.generatedAt?.trim();
  const resolved = resolvedId
    ? [...new Set([...(thread.resolvedAiDraftIds ?? []), resolvedId])]
    : thread.resolvedAiDraftIds;
  return {
    ...thread,
    aiDraft: next,
    aiDraftQueue: rest.length > 0 ? rest : undefined,
    ...(resolved && resolved.length > 0 ? { resolvedAiDraftIds: resolved } : {}),
  };
}

/**
 * Reads defensively on purpose.
 *
 * `inboxThreadManagerReplyPending` takes a `Pick<…, "folder" | "body" |
 * "messages" | "rootOutbound">` — its signature promises `id` and `from` are
 * NOT needed — and then casts to the full row on the way here. A caller that
 * honours that contract passed a row with no `id`, and this threw
 * `Cannot read properties of undefined (reading 'startsWith')` rather than
 * answering "no, not an assistant thread". Persisted rows come from
 * localStorage and server JSON too, so a missing field is a real shape, not
 * only a test one.
 */
function isPropLaneAssistantInboxThreadRow(thread: PersistedInboxThread): boolean {
  const extended = thread as PersistedInboxThread & { threadType?: string };
  const id = typeof thread.id === "string" ? thread.id : "";
  const from = typeof thread.from === "string" ? thread.from : "";
  return (
    extended.threadType === "resident_agent" ||
    extended.threadType === "agent_notice" ||
    id.startsWith("resident-agent-") ||
    id.startsWith("agent_notice_") ||
    from.trim() === RESIDENT_AGENT_FROM_NAME
  );
}

function isPropLaneAssistantSenderName(from: string | undefined): boolean {
  const name = from?.trim() ?? "";
  return (
    name === RESIDENT_AGENT_FROM_NAME ||
    name === "PropLane Assistant" ||
    name === "PropLane"
  );
}

/**
 * Whether a thread turn is outbound from the inbox owner's perspective.
 * Assistant-authored ice bubbles are a separate kind — see `inboxTurnDirection`.
 */
export function inboxMessageOutbound(
  message: InboxThreadMessage,
  index: number,
  folder: PersistedInboxThread["folder"],
  thread?: PersistedInboxThread,
): boolean {
  if (message.outbound !== undefined) return message.outbound;
  if (thread && isPropLaneAssistantInboxThreadRow(thread)) {
    return !isPropLaneAssistantSenderName(message.from);
  }
  return index === 0 ? folder === "sent" : true;
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

  const fullThread = thread as PersistedInboxThread;
  let lastInboundIndex = -1;
  for (let i = 0; i < turns.length; i++) {
    if (!inboxMessageOutbound(turns[i]!, i, thread.folder, fullThread)) lastInboundIndex = i;
  }
  if (lastInboundIndex < 0) return false;

  for (let i = lastInboundIndex + 1; i < turns.length; i++) {
    if (inboxMessageOutbound(turns[i]!, i, thread.folder, fullThread)) return false;
  }
  return true;
}

/** Resolve a collapsed person-thread id for deep-linking Communication from another surface. */
export function findCollapsedInboxThreadIdForEmail(
  storageKey: string,
  email: string,
  opts?: { mergeFolders?: boolean },
): string | null {
  const norm = trimmedText(email).toLowerCase();
  if (!norm.includes("@")) return null;
  const rows = loadPersistedInbox(storageKey, []);
  const collapsed = collapsePersonInboxThreads(rows, {
    mergeFolders: opts?.mergeFolders ?? true,
  });
  return collapsed.find((thread) => inboxThreadCounterpartyEmail(thread) === norm)?.id ?? null;
}

/**
 * `InboxThreadMessage` says `body: string`, but every message here was read
 * back out of a `row_data` JSON blob — the type describes what writers intend,
 * not what storage guarantees. A single legacy message with no `body` used to
 * throw "Cannot read properties of undefined (reading 'trim')" out of
 * `collapseAssistantInboxThreads`, and because the resident nav-count poll hits
 * `GET /api/portal-inbox-threads` on EVERY page, one such row 500'd the whole
 * resident portal — reported as a console error on ten separate screens.
 *
 * Normalizing at this boundary means no consumer downstream has to know that.
 */
function normalizeThreadMessage(message: InboxThreadMessage): InboxThreadMessage {
  return {
    ...message,
    id: String(message.id ?? ""),
    from: String(message.from ?? ""),
    body: String(message.body ?? ""),
    at: String(message.at ?? ""),
  };
}

/**
 * The channel the counterparty most recently reached us on, or null when no
 * inbound turn carries a stamp (legacy rows, or a thread the owner started).
 * "Reply on the channel they used" reads this; an unstamped thread keeps the
 * surface's own default rather than guessing.
 */
export function lastInboundChannelOf(thread: PersistedInboxThread): InboxThreadMessageChannel | null {
  const turns = inboxThreadMessages(thread);
  // The root is inbound when flagged so, or — on a row that never recorded a
  // direction — when it sits in the inbox folder. A merged person-thread keeps
  // the Sent copy's folder but records `rootOutbound: false` for an emailed-in
  // root, so the flag has to win over the folder.
  const rootInbound =
    thread.rootOutbound === false || (thread.rootOutbound === undefined && thread.folder === "inbox");
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (!turn || turn.outbound) continue;
    const isRoot = index === 0;
    // Later turns are inbound only when explicitly stamped so (see `outbound`).
    if (!isRoot && turn.outbound === undefined) continue;
    if (isRoot && !rootInbound) continue;
    if (turn.channel) return turn.channel;
  }
  // Work-email ingest keys the first row `assistant-email-<id>` and stamps
  // email on the root. A historical copy that lost the stamp still replies
  // by email — the in-app default would land on a row the sender cannot read.
  if (thread.id.startsWith("assistant-email-") && thread.folder === "inbox") return "email";
  return null;
}

/**
 * Newest inbound channel across a person's folded email threads (Direct Chat
 * merges several rows). Trash is ignored. Null when nothing is stamped.
 */
export function lastInboundChannelFromThreads(
  threads: readonly PersistedInboxThread[],
): InboxThreadMessageChannel | null {
  let best: { ms: number; channel: InboxThreadMessageChannel } | null = null;
  for (const thread of threads) {
    if (thread.folder === "trash") continue;
    const channel = lastInboundChannelOf(thread);
    if (!channel) continue;
    const ms = inboxThreadSortMs(thread.id, thread.time);
    if (!best || ms > best.ms) best = { ms, channel };
  }
  return best?.channel ?? null;
}

/**
 * Rows written before `rootAt` existed carry no time of their own for the root
 * turn, and `time` has moved on with every append. The root is by definition
 * older than anything appended to it, so the earliest appended stamp is a
 * tighter bound than the thread's latest activity — it keeps the root sorting
 * FIRST in a merged person-thread instead of after the replies to it.
 */
function earliestAppendedAt(thread: PersistedInboxThread): string | null {
  let best: { at: string; ms: number } | null = null;
  for (const message of thread.messages ?? []) {
    const at = String(message?.at ?? "").trim();
    if (!at) continue;
    const ms = inboxThreadSortMs(message.id, at);
    if (!ms) continue;
    if (!best || ms < best.ms) best = { at, ms };
  }
  return best?.at ?? null;
}

export function inboxThreadMessages(thread: PersistedInboxThread): InboxThreadMessage[] {
  const rootId = `${thread.id}-root`;
  const root: InboxThreadMessage = normalizeThreadMessage({
    id: rootId,
    from: thread.from,
    body: thread.body,
    at: thread.rootAt || earliestAppendedAt(thread) || thread.time,
    // An explicit direction on the row wins either way. `false` matters as much
    // as `true`: a merged person-thread lives under the Sent copy's id, and
    // without the explicit `false` the folder rule would draw the person's
    // emailed-in first message as the manager's own bubble.
    ...(thread.rootOutbound === true
      ? { outbound: true }
      : thread.rootOutbound === false
        ? { outbound: false }
        : {}),
    ...(thread.attachments?.length ? { attachments: thread.attachments } : {}),
    ...(thread.rootChannel ? { channel: thread.rootChannel } : {}),
    ...(thread.rootSubject ? { subject: thread.rootSubject } : {}),
  });
  // Merged person-threads can carry a prior thread's synthetic root in `messages`.
  // A collapsed row may itself later be persisted and merged again, which can
  // repeat a `merged:<thread>-root` entry. Message ids are their identity, so
  // retain the first occurrence only; otherwise React receives duplicate keys
  // and renders an unreliable timeline.
  const seenIds = new Set([rootId]);
  const extras = (thread.messages ?? []).map(normalizeThreadMessage).filter((message) => {
    if (!message.id || seenIds.has(message.id)) return false;
    if (
      isPropLaneAssistantInboxThreadRow(thread) &&
      isPropLaneAssistantSenderName(message.from) &&
      message.body.trim() === (thread.body ?? "").trim()
    ) {
      return false;
    }
    seenIds.add(message.id);
    return true;
  });
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
 * True only for a stamp this module wrote. Callers that need a DATE out of a
 * stamp use it to refuse anything else: `parseInboxStampMs` is deliberately
 * lenient so ordering degrades gracefully, but a lenient read of "9:00" is fine
 * for sorting and wrong for printing a day heading.
 */
export function isCanonicalInboxStamp(value?: string | null): boolean {
  return CANONICAL_INBOX_STAMP.test(String(value ?? "").trim());
}

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
 * A row that a sibling ALREADY folded in (its id is in that sibling's
 * `sourceThreadIds`) is a stale copy: the client still holds the pre-merge
 * inbox row while the server has started returning the merged row under the
 * Sent copy's id. Both carry the same root under different ids, so the id
 * dedupe below cannot see them as one — the person's first message rendered
 * twice. Keep the row that did the folding.
 */
function dropSubsumedMembers(group: PersistedInboxThread[]): PersistedInboxThread[] {
  if (group.length <= 1) return group;
  const subsumed = new Set<string>();
  for (const thread of group) {
    for (const id of thread.sourceThreadIds ?? []) {
      if (id !== thread.id) subsumed.add(id);
    }
  }
  if (subsumed.size === 0) return group;
  return group.filter((thread) => !subsumed.has(thread.id));
}

/**
 * A reply typed in a person thread is written twice by the send route: appended
 * to the thread the manager was looking at, and as the root of their own Sent
 * copy. Merging the folders then shows the same outbound turn back to back.
 * Drop a Sent-copy ROOT whose text and minute match an outbound turn that is
 * already in the merged history — only roots (ids ending in `-root`), only
 * outbound, only exact text, so two genuinely different replies are never folded.
 */
function dedupeSentCopyRoots(ordered: InboxThreadMessage[]): void {
  const outboundKeys = new Set<string>();
  for (const message of ordered) {
    if (message.outbound && !message.id.endsWith("-root")) {
      outboundKeys.add(`${message.at}\u0000${message.body.trim()}`);
    }
  }
  if (outboundKeys.size === 0) return;
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const message = ordered[index]!;
    if (!message.outbound || !message.id.endsWith("-root")) continue;
    if (outboundKeys.has(`${message.at}\u0000${message.body.trim()}`)) ordered.splice(index, 1);
  }
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
    const counterparty = smsNoticeIdentity(thread) || inboxThreadCounterpartyEmail(thread);
    const isNoticeIdentity = counterparty.startsWith("sms-notice:");
    if (!counterparty.includes("@") && !isNoticeIdentity) {
      solo.push(thread);
      continue;
    }
    // The ordinary, folder-scoped listing (`mergeFolders` false) keeps an
    // archived thread its own row — Active must never show an Archived row.
    // Only the cross-folder MERGED person view (`mergeFolders`, e.g. the open
    // direct-chat pane and the manager list's own person-collapse) heals a
    // same-person archived predecessor back into the live conversation here:
    // a past delivery-side bug could fork a new near-empty active thread
    // beside the real, archived history for the same person (captain
    // resurrection sweep) — the canonical (most recently active) thread wins
    // folder and every message from both merges into one timeline.
    if (thread.folder === "trash" && !isNoticeIdentity && !mergeFolders) {
      solo.push(thread);
      continue;
    }
    const key = mergeFolders ? counterparty : `${thread.folder}:${counterparty}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(thread);
    groups.set(key, bucket);
  }

  const merged: PersistedInboxThread[] = [...solo];
  for (const rawGroup of groups.values()) {
    const group = dropSubsumedMembers(rawGroup);
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
      allMessages.push(...inboxThreadMessages(th).map((message, index) => index === 0
        ? { ...message, outbound: th.rootOutbound ?? (th.folder === "sent") }
        : message));
    }
    const seenIds = new Set<string>();
    const ordered = allMessages.filter((m) => {
      if (seenIds.has(m.id)) return false;
      seenIds.add(m.id);
      return true;
    });
    ordered.sort((a, b) => inboxThreadSortMs(a.id, a.at) - inboxThreadSortMs(b.id, b.at));
    dedupeSentCopyRoots(ordered);
    const first = ordered[0];
    if (!first) {
      merged.push(canonical);
      continue;
    }
    const last = ordered[ordered.length - 1]!;
    const smsBindings = mergeInboxSmsBindingKeys(group);
    const canonicalRootId = `${canonical.id}-root`;
    const messages = ordered.slice(1).map((m) =>
      m.id === canonicalRootId ? { ...m, id: `merged:${m.id}` } : m,
    );
    merged.push({
      ...canonical,
      sourceThreadIds: [...new Set(group.flatMap((t) => t.sourceThreadIds ?? [t.id]))],
      ...mergeInboxReadSourceState(group),
      body: first.body,
      attachments: first.attachments,
      rootAt: first.at,
      rootOutbound: first.outbound === true,
      // The root's stamps travel with it: the merged row spreads `canonical`
      // (usually the newest Sent copy), whose root is not this one.
      rootChannel: first.channel,
      rootSubject: first.subject,
      from: first.from,
      time: canonical.time,
      preview: last.body.slice(0, 100).replace(/\n/g, " "),
      messages,
      unread: group.some((t) => t.unread),
      ...(smsBindings.length === 1 ? { smsConversationKey: smsBindings[0] } : { smsConversationKey: undefined }),
      ...(smsBindings.length > 0 ? { smsBindingKeys: smsBindings } : {}),
    });
  }
  return merged;
}

export async function markPersistedInboxSourcesRead(
  key: string,
  sources: { id: string; observation: string }[],
): Promise<{ id: string; status: "read" | "alreadyRead" | "changed" | "archived" | "failed"; unread: boolean }[] | null> {
  if (!canUse() || key !== MANAGER_INBOX_STORAGE_KEY || sources.length === 0) return null;
  const response = await fetch("/api/portal-inbox-threads", {
    method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "markRead", scope: key, sources }),
  });
  const body = await response.json().catch(() => null) as { results?: { id: string; status: "read" | "alreadyRead" | "changed" | "archived" | "failed"; unread: boolean }[] } | null;
  const results = body?.results;
  const requested = new Set(sources.map((source) => source.id));
  const validStatuses = new Set(["read", "alreadyRead", "changed", "archived", "failed"]);
  if (
    !Array.isArray(results) ||
    results.length !== requested.size ||
    results.some((result) =>
      !result ||
      typeof result.id !== "string" ||
      !requested.has(result.id) ||
      !validStatuses.has(result.status) ||
      typeof result.unread !== "boolean",
    ) ||
    new Set(results.map((result) => result.id)).size !== requested.size
  ) return null;
  return results;
}

/** Patch unread metadata only while the exact GET observations are still current. */
export function reconcileObservedInboxReadRows(
  rows: PersistedInboxThread[],
  sources: { id: string; observation: string }[],
  unreadById: ReadonlyMap<string, boolean>,
  opts?: { phase?: "optimistic" | "settled"; token?: string; settled?: "confirmed" | "withdraw" },
): PersistedInboxThread[] {
  const exact = new Map(sources.map((source) => [source.id, source.observation]));
  const sourceIds = new Set(exact.keys());
  const targetEmails = new Set(
    rows
      .filter((thread) => (thread.readSources ?? []).some((source) => sourceIds.has(source.id)))
      .map((thread) => thread.email.trim().toLowerCase())
      .filter(Boolean),
  );
  const groupIsComplete = new Map<string, boolean>();
  for (const email of targetEmails) {
    const members = rows.filter((thread) => thread.email.trim().toLowerCase() === email && thread.folder !== "trash");
    groupIsComplete.set(email, members.length > 0 && members.every((thread) => {
      const currentSources = thread.readSources ?? [];
      return thread.readSourcesComplete === true && currentSources.length > 0 && currentSources.every((source) =>
        exact.get(source.id) === source.observation &&
        (opts?.phase === "settled" || unreadById.has(source.id)),
      );
    }));
  }
  return rows.map((thread) => {
    if (thread.folder === "trash") return thread;
    const email = thread.email.trim().toLowerCase();
    if (!targetEmails.has(email) || groupIsComplete.get(email) !== true) return thread;
    const currentSources = thread.readSources ?? [];
    // A collapsed row is an aggregate. An old operation may settle it only
    // while every current source is still exactly represented. Confirmed
    // updates still require an explicit result; an unknown outcome only
    // withdraws its own overlay. Legacy or conflicting metadata deliberately
    // leaves the row untouched rather than guessing that unseen content is read.
    if (thread.readSourcesComplete !== true || currentSources.length === 0 || currentSources.some((source) =>
      exact.get(source.id) !== source.observation ||
      (opts?.phase !== "settled" && !unreadById.has(source.id)),
    )) return thread;
    const nextSources = currentSources.map((source) => {
      if (opts?.phase === "optimistic") {
        const unread = unreadById.get(source.id)!;
        const optimistic = source.optimistic;
        if (optimistic && optimistic.token === opts.token && optimistic.unread === unread) return source;
        return { ...source, optimistic: { token: opts?.token ?? "", unread } };
      }
      if (opts?.settled === "withdraw") {
        // A rejected, missing, or malformed outcome has no authority to alter
        // server truth. It can only remove the overlay this operation owns.
        if (source.optimistic?.token !== opts.token) return source;
        const next = { ...source };
        delete next.optimistic;
        return next;
      }
      if (!unreadById.has(source.id)) return source;
      const unread = unreadById.get(source.id)!;
      const next = { ...source, unread };
      // A settled operation may withdraw only its own overlay. A later
      // operation remains visually authoritative until it settles.
      if (next.optimistic?.token === opts?.token) delete next.optimistic;
      return next;
    });
    const unread = nextSources.some((source) => source.optimistic?.unread ?? source.unread === true);
    const sourcesChanged = nextSources.some((source, index) => source !== currentSources[index]);
    return thread.unread === unread && !sourcesChanged
      ? thread
      : { ...thread, readSources: nextSources, unread };
  });
}

/** Union GET-only observations. Any duplicate disagreement is unsafe to acknowledge. */
export function mergeInboxReadSources(
  sources: NonNullable<PersistedInboxThread["readSources"]>,
): NonNullable<PersistedInboxThread["readSources"]> {
  const byId = new Map<string, Omit<NonNullable<PersistedInboxThread["readSources"]>[number], "id">>();
  for (const source of sources) {
    const previous = byId.get(source.id);
    if (
      previous &&
      (previous.observation !== source.observation ||
        (previous.unread !== undefined && source.unread !== undefined && previous.unread !== source.unread))
    ) return [];
    byId.set(source.id, {
      observation: source.observation,
      unread: previous?.unread ?? source.unread,
      // Overlays are local to a rendered row. A collapse must not let an
      // arbitrary canonical row lend one to another source.
      ...(previous?.optimistic ? { optimistic: previous.optimistic } : source.optimistic ? { optimistic: source.optimistic } : {}),
    });
  }
  return [...byId].map(([id, source]) => ({ id, ...source }));
}

function mergeInboxReadSourceState(threads: PersistedInboxThread[]): Pick<PersistedInboxThread, "readSources" | "readSourcesComplete"> {
  // A missing marker is an old or partial projection. It must wait for a fresh
  // GET instead of being acknowledged from an observation subset.
  if (threads.some((thread) => thread.readSourcesComplete !== true || !(thread.readSources?.length))) {
    return { readSources: [], readSourcesComplete: false };
  }
  const readSources = mergeInboxReadSources(threads.flatMap((thread) => thread.readSources ?? []));
  return { readSources, readSourcesComplete: readSources.length > 0 };
}

/**
 * Bindings are provenance from actual selected email records. Never derive one
 * from a historical source id, a contact, or an SMS payload. A multi-key set is
 * intentionally retained so the reader can resolve each exact native member
 * without treating a conflict as permission for email fallback.
 */
function mergeInboxSmsBindingKeys(threads: PersistedInboxThread[]): string[] {
  return [...new Set(
    threads.flatMap((thread) => [
      ...(thread.smsBindingKeys ?? []),
      thread.smsConversationKey ?? "",
    ])
      .map((key) => key.trim())
      .filter(Boolean),
  )];
}

function applyInboxCollapseForScope(key: string, rows: PersistedInboxThread[]): PersistedInboxThread[] {
  let result = rows;
  if (key === MANAGER_INBOX_STORAGE_KEY) {
    result = collapsePersonInboxThreads(result, { mergeFolders: true });
  }
  if (
    key === MANAGER_INBOX_STORAGE_KEY ||
    key === RESIDENT_INBOX_STORAGE_KEY ||
    key === VENDOR_INBOX_STORAGE_KEY
  ) {
    result = collapseAssistantInboxThreads(result);
  }
  return result;
}

/**
 * Collapse duplicate PropLane Assistant threads (legacy per-manager ids, etc.)
 * into one row per resident or manager without rewriting storage.
 */
export function collapseAssistantInboxThreads(threads: PersistedInboxThread[]): PersistedInboxThread[] {
  const solo: PersistedInboxThread[] = [];
  const groups = new Map<string, PersistedInboxThread[]>();

  for (const thread of threads) {
    const key = assistantInboxCollapseKey(thread);
    if (!key) {
      solo.push(thread);
      continue;
    }
    const bucket = groups.get(key) ?? [];
    bucket.push(thread);
    groups.set(key, bucket);
  }

  const merged: PersistedInboxThread[] = [...solo];
  for (const [groupKey, group] of groups) {
    if (group.length <= 1) {
      merged.push(group[0]!);
      continue;
    }

    const sorted = [...group].sort(
      (a, b) => inboxThreadSortMs(a.id, a.time) - inboxThreadSortMs(b.id, b.time),
    );

    let canonical = sorted[sorted.length - 1]!;
    const residentMatch = groupKey.match(/^resident_agent:(.+)$/);
    if (residentMatch?.[1]) {
      const canonicalId = canonicalResidentAgentThreadId(residentMatch[1]);
      canonical =
        group.find((thread) => thread.id === canonicalId) ??
        sorted[sorted.length - 1]!;
      canonical = { ...canonical, id: canonicalId };
    }

    const allMessages: InboxThreadMessage[] = [];
    for (const thread of sorted) {
      allMessages.push(...inboxThreadMessages(thread));
    }
    const seenIds = new Set<string>();
    const ordered = allMessages
      .filter((message) => {
        if (!message.id || seenIds.has(message.id)) return false;
        seenIds.add(message.id);
        return message.body.trim().length > 0;
      })
      .sort((a, b) => inboxThreadSortMs(a.id, a.at) - inboxThreadSortMs(b.id, b.at));

    const first = ordered[0];
    const last = ordered[ordered.length - 1];
    const canonicalRootId = `${canonical.id}-root`;
    const messages = ordered.slice(1).map((message) =>
      message.id === canonicalRootId ? { ...message, id: `merged:${message.id}` } : message,
    );
    const boundManagerUserId =
      boundManagerUserIdFromThread(canonical) ??
      [...group].reverse().map(boundManagerUserIdFromThread).find(Boolean) ??
      undefined;

    merged.push({
      ...canonical,
      boundManagerUserId,
      sourceThreadIds: [...new Set(group.flatMap((thread) => thread.sourceThreadIds ?? [thread.id]))],
      ...mergeInboxReadSourceState(group),
      ...(mergeInboxSmsBindingKeys(group).length > 0
        ? { smsBindingKeys: mergeInboxSmsBindingKeys(group) }
        : {}),
      unread: group.some((thread) => thread.folder === "inbox" && thread.unread),
      body: first?.body ?? canonical.body,
      from: first?.from ?? canonical.from,
      rootAt: first?.at ?? canonical.rootAt,
      rootOutbound: first?.outbound ?? canonical.rootOutbound,
      attachments: first ? first.attachments : canonical.attachments,
      preview: (last?.body ?? canonical.preview).slice(0, 100).replace(/\n/g, " "),
      time: canonical.time,
      messages,
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
  const member = collapsed.find((t) => t.sourceThreadIds?.includes(expandedId));
  if (member) return member;
  const legacy = raw.find((t) => t.id === expandedId);
  if (!legacy) return null;
  const counterparty = inboxThreadCounterpartyEmail(legacy);
  if (!counterparty.includes("@")) return legacy;
  return (
    collapsed.find((t) => inboxThreadCounterpartyEmail(t) === counterparty) ?? legacy
  );
}
