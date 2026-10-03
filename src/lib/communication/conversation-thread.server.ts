import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ConversationRef } from "@/lib/communication/conversation-key.server";

/**
 * The storage half of "one conversation per person": finding the keyed row,
 * creating it through the database function (never a bare upsert), and
 * stamping the key on rows that already exist.
 *
 * Deploy safety: the migration that adds the columns and functions
 * (`20261003180000_one_conversation_per_person.sql`) is applied per
 * environment at promote time. Until it lands, every operation here notices
 * the missing column / function once, remembers it for a minute, and the
 * writer keeps the legacy per-email behaviour instead of failing the send.
 */

type Db = SupabaseClient;

export type StoredPersonThread = {
  id: string;
  rowData: Record<string, unknown>;
  ownerUserId: string | null;
  participantEmail: string | null;
  scope: string;
  updatedAt: string | null;
  /** The row's folder is `trash`. */
  archived: boolean;
  conversationKey: string | null;
  workspaceId: string | null;
  threadType: string | null;
};

let schemaMissingUntil = 0;
const SCHEMA_RETRY_MS = 60_000;

export function conversationSchemaAvailable(): boolean {
  return Date.now() >= schemaMissingUntil;
}

/** Test seam: forget a remembered "schema missing". */
export function resetConversationSchemaProbe(): void {
  schemaMissingUntil = 0;
}

function markSchemaMissing(): void {
  schemaMissingUntil = Date.now() + SCHEMA_RETRY_MS;
}

type PgError = { code?: string; message?: string } | null | undefined;

export function isMissingConversationSchema(error: PgError): boolean {
  if (!error) return false;
  const code = String(error.code ?? "");
  const message = String(error.message ?? "");
  return (
    code === "42703" ||
    code === "PGRST204" ||
    code === "PGRST202" ||
    code === "42883" ||
    /conversation_key|resolve_or_create_conversation|adopt_conversation|workspace_id/i.test(message)
  );
}

export function isUniqueViolation(error: PgError): boolean {
  return Boolean(error) && String(error!.code ?? "") === "23505";
}

const THREAD_COLUMNS =
  "id, row_data, owner_user_id, participant_email, thread_type, scope, updated_at, conversation_key, workspace_id";

function toStored(row: Record<string, unknown>): StoredPersonThread {
  const rowData = (row.row_data && typeof row.row_data === "object" ? row.row_data : {}) as Record<string, unknown>;
  return {
    id: String(row.id),
    rowData,
    ownerUserId: (row.owner_user_id as string | null) ?? null,
    participantEmail: (row.participant_email as string | null) ?? null,
    scope: String(row.scope ?? ""),
    updatedAt: (row.updated_at as string | null) ?? null,
    archived: String(rowData.folder ?? "") === "trash",
    conversationKey: (row.conversation_key as string | null) ?? null,
    workspaceId: (row.workspace_id as string | null) ?? null,
    threadType: (row.thread_type as string | null) ?? null,
  };
}

/**
 * The ONE stored thread this side already has for the person, whatever its
 * folder or thread type. Stronger keys win; ties go to the most recently
 * active row. `null` = none (or the schema is not there yet).
 */
export async function findThreadByConversation(
  db: Db,
  side: { scope: string; ownerUserId: string | null; participantEmail: string | null },
  ref: ConversationRef,
): Promise<StoredPersonThread | null> {
  if (!conversationSchemaAvailable()) return null;
  try {
    let query = db
      .from("portal_inbox_thread_records")
      .select(THREAD_COLUMNS)
      .eq("scope", side.scope)
      .eq("workspace_id", ref.workspaceId)
      .in("conversation_key", ref.keys);
    if (side.ownerUserId) {
      query = query.eq("owner_user_id", side.ownerUserId);
    } else {
      const email = String(side.participantEmail ?? "").trim().toLowerCase();
      if (!email) return null;
      query = query.is("owner_user_id", null).eq("participant_email", email);
    }
    const { data, error } = await query.order("updated_at", { ascending: false }).limit(20);
    if (error) {
      if (isMissingConversationSchema(error)) markSchemaMissing();
      return null;
    }
    const rows = (Array.isArray(data) ? data : []) as Record<string, unknown>[];
    if (rows.length === 0) return null;
    const rank = (row: Record<string, unknown>) => {
      const index = ref.keys.indexOf(String(row.conversation_key ?? ""));
      return index < 0 ? ref.keys.length : index;
    };
    rows.sort((a, b) => rank(a) - rank(b));
    return toStored(rows[0]!);
  } catch {
    return null;
  }
}

/** The columns a keyed row carries, or nothing when the schema is not there yet. */
export function conversationColumns(ref: ConversationRef | null): Record<string, string> {
  if (!ref || !conversationSchemaAvailable()) return {};
  return { conversation_key: ref.key, workspace_id: ref.workspaceId };
}

/** What a keyed row remembers in `row_data` (also read by clients). */
export function conversationRowData(ref: ConversationRef | null): Record<string, unknown> {
  if (!ref) return {};
  return {
    conversationKey: ref.key,
    workspaceId: ref.workspaceId,
    ...(ref.flagged ? { identityFlag: ref.flagged } : {}),
  };
}

/**
 * Write a row that may carry the conversation columns. A missing column is
 * remembered and the same write retried without them; a unique violation
 * (another writer created this person's conversation between our read and
 * write) is reported so the caller can re-read and append to the winner.
 */
export async function upsertKeyedThreadRow(
  db: Db,
  payload: Record<string, unknown>,
  ref: ConversationRef | null,
): Promise<{ error: PgError; conflict: boolean }> {
  const withColumns = { ...payload, ...conversationColumns(ref) };
  const first = await db.from("portal_inbox_thread_records").upsert(withColumns, { onConflict: "id" });
  if (!first.error) return { error: null, conflict: false };
  if (isUniqueViolation(first.error) && ref) return { error: first.error, conflict: true };
  if (ref && isMissingConversationSchema(first.error)) {
    markSchemaMissing();
    const retry = await db.from("portal_inbox_thread_records").upsert(payload, { onConflict: "id" });
    return { error: retry.error ?? null, conflict: false };
  }
  return { error: first.error, conflict: false };
}

/**
 * Create a person's conversation. The database function takes a lock on
 * (owner, workspace) and returns the existing row when two writers race, so a
 * pair of simultaneous sends can never mint two threads. `created: false`
 * means "someone else just made it": the caller appends to the returned id.
 */
export async function createKeyedThreadRow(
  db: Db,
  ref: ConversationRef,
  row: {
    id: string;
    scope: string;
    ownerUserId: string | null;
    participantEmail: string | null;
    threadType: string;
    rowData: Record<string, unknown>;
  },
  /** `insert` refuses to replace a row already on this id (the property chat's stable ids). */
  mode: "upsert" | "insert" = "upsert",
): Promise<{ id: string; created: boolean; error?: PgError }> {
  const legacyUpsert = async () => {
    const write = mode === "insert"
      ? (payload: Record<string, unknown>) => db.from("portal_inbox_thread_records").insert(payload)
      : (payload: Record<string, unknown>) => db.from("portal_inbox_thread_records").upsert(payload, { onConflict: "id" });
    const { error } = await write(
      {
        id: row.id,
        scope: row.scope,
        owner_user_id: row.ownerUserId,
        participant_email: row.participantEmail,
        thread_type: row.threadType,
        row_data: row.rowData,
        updated_at: new Date().toISOString(),
      },
    );
    return { id: row.id, created: true, error };
  };
  if (!conversationSchemaAvailable() || typeof (db as { rpc?: unknown }).rpc !== "function") return legacyUpsert();
  try {
    const { data, error } = await db.rpc("resolve_or_create_conversation", {
      p_owner: row.ownerUserId,
      p_workspace: ref.workspaceId,
      p_keys: ref.keys,
      p_scope: row.scope,
      p_thread_id: row.id,
      p_participant_email: row.participantEmail,
      p_thread_type: row.threadType,
      p_row_data: { ...row.rowData, ...conversationRowData(ref) },
    });
    if (error) {
      if (isMissingConversationSchema(error)) {
        markSchemaMissing();
        return legacyUpsert();
      }
      return { id: row.id, created: false, error };
    }
    const result = (data ?? {}) as { id?: unknown; created?: unknown };
    const id = String(result.id ?? "").trim();
    if (!id) return legacyUpsert();
    return { id, created: result.created === true };
  } catch {
    return legacyUpsert();
  }
}

/** Stamp an existing (legacy) row with its key; `false` when another row already holds it. */
export async function adoptThreadIntoConversation(db: Db, threadId: string, ref: ConversationRef): Promise<boolean> {
  if (!conversationSchemaAvailable() || typeof (db as { rpc?: unknown }).rpc !== "function") return false;
  try {
    const { data, error } = await db.rpc("adopt_conversation", {
      p_thread_id: threadId,
      p_workspace: ref.workspaceId,
      p_key: ref.key,
    });
    if (error) {
      if (isMissingConversationSchema(error)) markSchemaMissing();
      return false;
    }
    return (data as { adopted?: unknown } | null)?.adopted === true;
  } catch {
    return false;
  }
}

/**
 * An old thread id that a folded conversation still answers to (tour links,
 * deep links, a reply composed against a stale id). `null` when the id is not
 * an alias, or the aliases table is not there yet.
 */
export async function resolveThreadAlias(db: Db, aliasId: string): Promise<string | null> {
  const id = aliasId.trim();
  if (!id || !conversationSchemaAvailable()) return null;
  try {
    const { data, error } = await db
      .from("portal_inbox_thread_aliases")
      .select("thread_id")
      .eq("alias_id", id)
      .maybeSingle();
    if (error) {
      if (isMissingConversationSchema(error) || /portal_inbox_thread_aliases/.test(String(error.message ?? ""))) markSchemaMissing();
      return null;
    }
    const threadId = String((data as { thread_id?: unknown } | null)?.thread_id ?? "").trim();
    return threadId || null;
  } catch {
    return null;
  }
}
