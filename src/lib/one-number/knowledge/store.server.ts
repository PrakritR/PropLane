import "server-only";

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { KnowledgeEntryStatus } from "../contracts";
import { isMissingSchemaError } from "../config.server";
import { normalizeTopic, type ReplyTopic } from "./topics";
import {
  asAudience,
  type KnowledgeAudience,
  type KnowledgeEntry,
  type KnowledgeSource,
} from "./types";

const ENTRY_COLUMNS =
  "id, workspace_id, property_id, topic, question, answer, status, source, source_ref, audience, use_count, last_used_at, created_at, updated_at";

function str(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

export function entryFromRow(row: Record<string, unknown>): KnowledgeEntry {
  const status = str(row.status);
  return {
    id: str(row.id),
    workspaceId: str(row.workspace_id),
    propertyId: row.property_id == null || str(row.property_id).trim() === "" ? null : str(row.property_id),
    topic: normalizeTopic(row.topic),
    question: str(row.question),
    answer: str(row.answer),
    status: status === "approved" || status === "rejected" ? status : "suggested",
    source: (["manager_answer", "draft_edit", "manual", "import"].includes(str(row.source))
      ? str(row.source)
      : "manual") as KnowledgeSource,
    sourceRef: row.source_ref == null ? null : str(row.source_ref),
    audience: asAudience(row.audience),
    useCount: Number(row.use_count ?? 0) || 0,
    lastUsedAt: row.last_used_at == null ? null : str(row.last_used_at),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  };
}

export function normalizeQuestionKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Approved entries a turn may quote: this workspace only, team-wide entries plus
 * the allowed houses, and only audiences the asker may hear. A missing table
 * reads as "nothing here".
 */
export async function loadAnswerableEntries(
  db: SupabaseClient,
  args: {
    workspaceId: string;
    allowedPropertyIds: readonly string[] | null;
    audiences: readonly KnowledgeAudience[];
  },
): Promise<KnowledgeEntry[]> {
  if (!args.workspaceId.trim() || args.audiences.length === 0) return [];
  try {
    const { data, error } = await db
      .from("property_knowledge_entries")
      .select(ENTRY_COLUMNS)
      .eq("workspace_id", args.workspaceId)
      .eq("status", "approved")
      .in("audience", [...args.audiences])
      .order("updated_at", { ascending: false })
      .limit(500);
    if (error) {
      if (!isMissingSchemaError(error)) console.error("knowledge entries read failed", error.message);
      return [];
    }
    const allowed = args.allowedPropertyIds ? new Set(args.allowedPropertyIds) : null;
    return ((data ?? []) as Record<string, unknown>[])
      .map(entryFromRow)
      .filter((entry) => entry.workspaceId === args.workspaceId)
      .filter((entry) => entry.propertyId === null || !allowed || allowed.has(entry.propertyId));
  } catch (error) {
    console.error("knowledge entries read threw", error instanceof Error ? error.message : "unknown");
    return [];
  }
}

/** Count a use. Best effort: a lost increment never fails an answer. */
export async function recordEntryUse(db: SupabaseClient, workspaceId: string, entries: readonly KnowledgeEntry[]): Promise<void> {
  const now = new Date().toISOString();
  for (const entry of entries) {
    if (entry.workspaceId !== workspaceId) continue;
    try {
      await db
        .from("property_knowledge_entries")
        .update({ use_count: entry.useCount + 1, last_used_at: now })
        .eq("id", entry.id)
        .eq("workspace_id", workspaceId);
    } catch {
      /* best effort */
    }
  }
}

export type ListEntriesArgs = {
  workspaceId: string;
  /** undefined = every entry in the workspace, null = team-wide only, string = that house only. */
  propertyId?: string | null;
  statuses?: readonly KnowledgeEntryStatus[];
};

export async function listEntries(db: SupabaseClient, args: ListEntriesArgs): Promise<KnowledgeEntry[]> {
  try {
    let query = db
      .from("property_knowledge_entries")
      .select(ENTRY_COLUMNS)
      .eq("workspace_id", args.workspaceId)
      .order("updated_at", { ascending: false })
      .limit(500);
    if (args.statuses?.length) query = query.in("status", [...args.statuses]);
    if (args.propertyId === null) query = query.is("property_id", null);
    else if (typeof args.propertyId === "string") query = query.eq("property_id", args.propertyId);
    const { data, error } = await query;
    if (error) {
      if (!isMissingSchemaError(error)) console.error("knowledge list failed", error.message);
      return [];
    }
    return ((data ?? []) as Record<string, unknown>[]).map(entryFromRow);
  } catch {
    return [];
  }
}

export async function getEntry(db: SupabaseClient, workspaceId: string, entryId: string): Promise<KnowledgeEntry | null> {
  try {
    const { data, error } = await db
      .from("property_knowledge_entries")
      .select(ENTRY_COLUMNS)
      .eq("id", entryId)
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    if (error || !data) return null;
    return entryFromRow(data as Record<string, unknown>);
  } catch {
    return null;
  }
}

export type CreateEntryArgs = {
  workspaceId: string;
  propertyId: string | null;
  topic: ReplyTopic;
  question: string;
  answer: string;
  status: KnowledgeEntryStatus;
  source: KnowledgeSource;
  sourceRef?: string | null;
  audience?: KnowledgeAudience;
  createdBy?: string | null;
};

/**
 * Create an entry. A suggestion that repeats an open suggestion (same house,
 * same question) returns the existing one instead of stacking duplicates.
 */
export async function createEntry(
  db: SupabaseClient,
  args: CreateEntryArgs,
): Promise<{ ok: true; entry: KnowledgeEntry; duplicate: boolean } | { ok: false }> {
  const question = args.question.trim().slice(0, 500);
  const answer = args.answer.trim().slice(0, 2000);
  if (!args.workspaceId.trim() || !question || !answer) return { ok: false };
  try {
    if (args.status === "suggested") {
      const open = await listEntries(db, {
        workspaceId: args.workspaceId,
        propertyId: args.propertyId,
        statuses: ["suggested"],
      });
      const key = normalizeQuestionKey(question);
      const same = open.find((e) => normalizeQuestionKey(e.question) === key);
      if (same) return { ok: true, entry: same, duplicate: true };
    }
    const now = new Date().toISOString();
    const row = {
      id: randomUUID(),
      workspace_id: args.workspaceId,
      property_id: args.propertyId,
      topic: args.topic,
      question,
      answer,
      status: args.status,
      source: args.source,
      source_ref: args.sourceRef ?? null,
      audience: args.audience ?? "residents",
      created_by: args.createdBy ?? null,
      ...(args.status === "approved" ? { decided_by: args.createdBy ?? null, decided_at: now } : {}),
      created_at: now,
      updated_at: now,
    };
    const { error } = await db.from("property_knowledge_entries").insert(row);
    if (error) {
      if (!isMissingSchemaError(error)) console.error("knowledge entry insert failed", error.message);
      return { ok: false };
    }
    return { ok: true, entry: entryFromRow(row), duplicate: false };
  } catch {
    return { ok: false };
  }
}

export type EntryPatch = {
  question?: string;
  answer?: string;
  topic?: ReplyTopic;
  audience?: KnowledgeAudience;
  /** null = team-wide. The caller has already proven the house belongs to the workspace. */
  propertyId?: string | null;
  status?: KnowledgeEntryStatus;
};

/** Update an entry the workspace owns. `decidedBy` is stamped when the status moves. */
export async function updateEntry(
  db: SupabaseClient,
  args: { workspaceId: string; entryId: string; patch: EntryPatch; decidedBy?: string | null },
): Promise<KnowledgeEntry | null> {
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (args.patch.question !== undefined) {
    const q = args.patch.question.trim().slice(0, 500);
    if (!q) return null;
    patch.question = q;
  }
  if (args.patch.answer !== undefined) {
    const a = args.patch.answer.trim().slice(0, 2000);
    if (!a) return null;
    patch.answer = a;
  }
  if (args.patch.topic !== undefined) patch.topic = args.patch.topic;
  if (args.patch.audience !== undefined) patch.audience = args.patch.audience;
  if (args.patch.propertyId !== undefined) patch.property_id = args.patch.propertyId;
  if (args.patch.status !== undefined) {
    patch.status = args.patch.status;
    patch.decided_by = args.decidedBy ?? null;
    patch.decided_at = new Date().toISOString();
  }
  try {
    const { error } = await db
      .from("property_knowledge_entries")
      .update(patch)
      .eq("id", args.entryId)
      .eq("workspace_id", args.workspaceId);
    if (error) return null;
    return await getEntry(db, args.workspaceId, args.entryId);
  } catch {
    return null;
  }
}

export async function deleteEntry(db: SupabaseClient, workspaceId: string, entryId: string): Promise<boolean> {
  try {
    const { error } = await db
      .from("property_knowledge_entries")
      .delete()
      .eq("id", entryId)
      .eq("workspace_id", workspaceId);
    return !error;
  } catch {
    return false;
  }
}
