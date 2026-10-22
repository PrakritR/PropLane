import "server-only";

import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createKeyedThreadRow } from "@/lib/communication/conversation-thread.server";
import { formatPacificDateTime } from "@/lib/pacific-time";
import { MANAGER_INBOX_STORAGE_KEY } from "@/lib/portal-inbox-storage";
import {
  HOUSE_ROOT_TEXT,
  HOUSE_THREAD_TYPE,
  houseConversationKey,
  houseThreadAliasToken,
  houseThreadDisplayName,
  houseThreadId,
} from "@/lib/house-thread-id";
import {
  readHouseChatState,
  type HouseChatMessage,
  type HouseChatState,
  type HouseResident,
  type HouseViewerState,
} from "./model";

/**
 * Storage half of the in-app house chat. One shared row per house per workspace, service role only
 * (`portal_inbox_thread_records` has RLS on and no client policy), created ONLY through
 * `createKeyedThreadRow` -> `resolve_or_create_conversation` under the key `house:<propertyId>`, so two
 * simultaneous creators make one chat. Every change after that is a compare-and-set on `updated_at`.
 * Authorization is NOT here: `access.server.ts` decides who may call these.
 */

type Db = SupabaseClient;
const ATTEMPTS = 5;
/** How many lines one house chat keeps; a list load hands back `HOUSE_LIST_MESSAGE_LIMIT` of them. */
export const HOUSE_HISTORY_LIMIT = 500;

function newHousePublicId(): string {
  return randomBytes(16).toString("hex");
}

export type StoredHouseThread = {
  id: string;
  rowData: Record<string, unknown>;
  ownerUserId: string;
  workspaceId: string | null;
  updatedAt: string | null;
};

export async function loadHouseThread(db: Db, threadId: string): Promise<StoredHouseThread | null> {
  const { data, error } = await db
    .from("portal_inbox_thread_records")
    .select("id, row_data, owner_user_id, workspace_id, updated_at, thread_type")
    .eq("id", threadId)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as Record<string, unknown>;
  if (String(row.thread_type ?? "") !== HOUSE_THREAD_TYPE) return null;
  return {
    id: String(row.id),
    rowData: (row.row_data && typeof row.row_data === "object" ? row.row_data : {}) as Record<string, unknown>,
    ownerUserId: String(row.owner_user_id ?? ""),
    workspaceId: (row.workspace_id as string | null) ?? null,
    updatedAt: (row.updated_at as string | null) ?? null,
  };
}

/**
 * The stored thread id behind a resident's opaque alias (`house-chat:<publicId>`); `null` when the token
 * names no house chat. The token is a lookup key, never a grant: the caller still authorizes the thread.
 */
export async function resolveHouseThreadAlias(db: Db, aliasId: string): Promise<string | null> {
  const token = houseThreadAliasToken(aliasId);
  if (!token) return null;
  const { data, error } = await db
    .from("portal_inbox_thread_records")
    .select("id")
    .eq("thread_type", HOUSE_THREAD_TYPE)
    .eq("row_data->houseChat->>publicId", token)
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return String((data as { id?: unknown }).id ?? "") || null;
}

/** The house's opaque resident-facing id, minted on first use for a chat created before it existed. */
export async function ensureHousePublicId(db: Db, threadId: string): Promise<string | null> {
  const stored = await loadHouseThread(db, threadId);
  if (!stored) return null;
  const existing = readHouseChatState(stored.rowData).publicId;
  if (existing) return existing;
  const minted = newHousePublicId();
  const saved = await mutateHouseThread(db, threadId, (rowData) => {
    const state = readHouseChatState(rowData);
    if (state.publicId) return null;
    return { ...rowData, houseChat: { ...state, publicId: minted } };
  });
  if (!saved) return null;
  return readHouseChatState((await loadHouseThread(db, threadId))?.rowData ?? {}).publicId ?? null;
}

/** Every house chat of one workspace (the manager list reads this; membership is filtered by the caller). */
export async function listWorkspaceHouseThreads(db: Db, workspaceIds: readonly string[]): Promise<StoredHouseThread[]> {
  const ids = [...new Set(workspaceIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) return [];
  const { data, error } = await db
    .from("portal_inbox_thread_records")
    .select("id, row_data, owner_user_id, workspace_id, updated_at")
    .eq("thread_type", HOUSE_THREAD_TYPE)
    .eq("scope", MANAGER_INBOX_STORAGE_KEY)
    .in("workspace_id", ids)
    .order("updated_at", { ascending: false })
    .limit(500);
  if (error) return [];
  return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    id: String(row.id),
    rowData: (row.row_data && typeof row.row_data === "object" ? row.row_data : {}) as Record<string, unknown>,
    ownerUserId: String(row.owner_user_id ?? ""),
    workspaceId: (row.workspace_id as string | null) ?? null,
    updatedAt: (row.updated_at as string | null) ?? null,
  }));
}

/**
 * Read-modify-write one house chat under a compare-and-set on `updated_at`, retried. `change` returns the
 * next `row_data`, or `null` for "nothing to write". Resolves `false` when the row is gone.
 */
export async function mutateHouseThread(
  db: Db,
  threadId: string,
  change: (rowData: Record<string, unknown>) => Record<string, unknown> | null,
): Promise<boolean> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const stored = await loadHouseThread(db, threadId);
    if (!stored) return false;
    const next = change(stored.rowData);
    if (!next) return true;
    const updatedAt = new Date(Math.max(Date.now(), Date.parse(String(stored.updatedAt ?? "")) + 1 || 0)).toISOString();
    const { data, error } = await db
      .from("portal_inbox_thread_records")
      .update({ row_data: next, updated_at: updatedAt })
      .eq("id", threadId)
      .eq("updated_at", stored.updatedAt)
      .select("id")
      .maybeSingle();
    if (error) return false;
    if (data) return true;
  }
  return false;
}

/**
 * The house's chat id, creating the row when missing. Returns `null` only when the row cannot be made.
 * Idempotent: the database function takes a lock on (owner, workspace) and returns the winner's id.
 */
export async function ensureHouseThread(
  db: Db,
  input: { ownerUserId: string; workspaceId: string; propertyId: string; houseLabel: string },
): Promise<string | null> {
  const owner = input.ownerUserId.trim();
  const workspaceId = input.workspaceId.trim();
  const propertyId = input.propertyId.trim();
  if (!owner || !workspaceId || !propertyId) return null;
  const threadId = houseThreadId(owner, workspaceId, propertyId);
  const existing = await loadHouseThread(db, threadId);
  if (existing) {
    if (readHouseChatState(existing.rowData).houseLabel !== input.houseLabel && input.houseLabel) {
      await mutateHouseThread(db, threadId, (rowData) => {
        const state = readHouseChatState(rowData);
        if (state.houseLabel === input.houseLabel) return null;
        return { ...rowData, houseChat: { ...state, houseLabel: input.houseLabel } };
      });
    }
    return threadId;
  }
  const title = houseThreadDisplayName(input.houseLabel);
  const when = formatPacificDateTime(new Date());
  const state: HouseChatState = { version: 1, houseLabel: input.houseLabel, publicId: newHousePublicId(), residents: [], viewerState: {} };
  const key = houseConversationKey(propertyId);
  const created = await createKeyedThreadRow(
    db,
    { workspaceId, key, keys: [key], flagged: null },
    {
      id: threadId,
      scope: MANAGER_INBOX_STORAGE_KEY,
      ownerUserId: owner,
      participantEmail: null,
      threadType: HOUSE_THREAD_TYPE,
      rowData: {
        id: threadId,
        folder: "inbox",
        from: title,
        email: "",
        subject: title,
        preview: "",
        body: HOUSE_ROOT_TEXT,
        time: when,
        rootAt: when,
        rootOutbound: true,
        unread: false,
        scope: MANAGER_INBOX_STORAGE_KEY,
        rootMessageId: `house-root:${threadId}`,
        workspaceId,
        houseId: propertyId,
        houseChat: state,
        messages: [],
      },
    },
    "insert",
  );
  if (created.error && !created.id) return null;
  return created.id || threadId;
}

/**
 * Append one line. Idempotent on `message.id` (a retried delivery posts once). A new line pulls the chat
 * back out of Archived for everyone who archived it.
 */
export async function appendHouseLine(
  db: Db,
  threadId: string,
  message: Omit<HouseChatMessage, "at" | "atMs">,
): Promise<{ ok: boolean; posted: boolean }> {
  let posted = false;
  const ok = await mutateHouseThread(db, threadId, (rowData) => {
    const messages = Array.isArray(rowData.messages) ? [...(rowData.messages as HouseChatMessage[])] : [];
    if (messages.some((m) => m?.id === message.id)) return null;
    const now = new Date();
    messages.push({ ...message, at: formatPacificDateTime(now), atMs: now.getTime() });
    // One row holds the chat, so the history is capped: the oldest lines fall off rather than growing a
    // row every member downloads without bound.
    if (messages.length > HOUSE_HISTORY_LIMIT) messages.splice(0, messages.length - HOUSE_HISTORY_LIMIT);
    const state = readHouseChatState(rowData);
    const viewerState: Record<string, HouseViewerState> = {};
    for (const [userId, value] of Object.entries(state.viewerState)) {
      viewerState[userId] = { ...value, folder: undefined };
    }
    posted = true;
    return {
      ...rowData,
      messages,
      preview: message.body.slice(0, 100).replace(/\n/g, " "),
      time: formatPacificDateTime(now),
      houseChat: { ...state, viewerState },
    };
  });
  return { ok, posted };
}

/** Replace the stored roster (narrowing + welcome bookkeeping only). */
export async function saveHouseRoster(
  db: Db,
  threadId: string,
  residents: (HouseResident & { joinedAt: string })[],
): Promise<boolean> {
  return mutateHouseThread(db, threadId, (rowData) => {
    const state = readHouseChatState(rowData);
    const same =
      state.residents.length === residents.length &&
      state.residents.every((r, i) => r.email === residents[i]?.email && r.roomLabel === residents[i]?.roomLabel);
    if (same) return null;
    return { ...rowData, houseChat: { ...state, residents } };
  });
}

/** One viewer's own mailbox state (archive, read marker). Nobody else's is touched. */
export async function setHouseViewerState(
  db: Db,
  threadId: string,
  userId: string,
  patch: { folder?: "inbox" | "trash"; read?: boolean },
): Promise<boolean> {
  return mutateHouseThread(db, threadId, (rowData) => {
    const state = readHouseChatState(rowData);
    const current = state.viewerState[userId] ?? {};
    const next: HouseViewerState = { ...current };
    if (patch.folder === "trash") next.folder = "trash";
    if (patch.folder === "inbox") delete next.folder;
    if (patch.read) next.readAtMs = Date.now();
    if (patch.read === false) next.readAtMs = 0;
    return { ...rowData, houseChat: { ...state, viewerState: { ...state.viewerState, [userId]: next } } };
  });
}
