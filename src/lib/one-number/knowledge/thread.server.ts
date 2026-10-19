import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingSchemaError } from "../config.server";
import { draftHouseAllowed } from "./draft-scope";
import { entryFromRow } from "./store.server";
import { loadOwnedProperty } from "./scope.server";
import type { KnowledgeEntry } from "./types";

export type ThreadDraft = {
  id: string;
  mode: "draft" | "auto_review";
  topic: string;
  body: string;
  inboundText: string;
  createdAt: string;
};

export type ThreadKnowledge = {
  /** Suggested answers captured from this person's conversation, waiting for Save / Edit / Dismiss. */
  suggestions: Array<KnowledgeEntry & { houseLabel: string | null }>;
  /** The AI's held draft (mode draft), shown in the composer; or a flagged auto-review reply. */
  draft: ThreadDraft | null;
  reviewing: ThreadDraft | null;
};

const EMPTY: ThreadKnowledge = { suggestions: [], draft: null, reviewing: null };

/**
 * Everything the Communication thread needs about the learning loop for one person, scoped to the
 * active workspace. A non-owner sees only suggestions about houses they hold.
 */
export async function loadThreadKnowledge(
  db: SupabaseClient,
  args: { workspaceId: string; ownerUserId: string; phoneKey: string; allowedPropertyIds: readonly string[] | null },
): Promise<ThreadKnowledge> {
  try {
    const { data: drafts, error: draftError } = await db
      .from("sms_ai_reply_drafts")
      .select("id, mode, topic, body, inbound_text, created_at, property_id")
      .eq("workspace_id", args.workspaceId)
      .eq("phone_key", args.phoneKey)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(10);
    if (draftError && !isMissingSchemaError(draftError)) return EMPTY;
    const toDraft = (row: Record<string, unknown>): ThreadDraft => ({
      id: String(row.id),
      mode: row.mode === "auto_review" ? "auto_review" : "draft",
      topic: String(row.topic),
      body: String(row.body),
      inboundText: String(row.inbound_text),
      createdAt: String(row.created_at),
    });
    const draftRows = ((drafts ?? []) as Record<string, unknown>[])
      .filter((row) => draftHouseAllowed(typeof row.property_id === "string" ? row.property_id : null, args.allowedPropertyIds))
      .map(toDraft);

    // The suggestion's origin is an escalated question or a draft of THIS person.
    const refs: string[] = [];
    const { data: escalated } = await db
      .from("sms_escalated_questions")
      .select("id, entry_id")
      .eq("workspace_id", args.workspaceId)
      .eq("phone_key", args.phoneKey)
      .not("entry_id", "is", null)
      .limit(50);
    for (const row of (escalated ?? []) as { id: string }[]) refs.push(String(row.id));
    const { data: edited } = await db
      .from("sms_ai_reply_drafts")
      .select("id")
      .eq("workspace_id", args.workspaceId)
      .eq("phone_key", args.phoneKey)
      .eq("status", "edited_sent")
      .limit(50);
    for (const row of (edited ?? []) as { id: string }[]) refs.push(String(row.id));

    let suggestions: Array<KnowledgeEntry & { houseLabel: string | null }> = [];
    if (refs.length) {
      const { data: entries } = await db
        .from("property_knowledge_entries")
        .select("id, workspace_id, property_id, topic, question, answer, status, source, source_ref, audience, use_count, last_used_at, created_at, updated_at")
        .eq("workspace_id", args.workspaceId)
        .eq("status", "suggested")
        .in("source_ref", refs)
        .order("created_at", { ascending: false })
        .limit(10);
      const list = ((entries ?? []) as Record<string, unknown>[])
        .map(entryFromRow)
        .filter((e) => !args.allowedPropertyIds || (e.propertyId !== null && args.allowedPropertyIds.includes(e.propertyId)));
      suggestions = await Promise.all(
        list.map(async (e) => ({
          ...e,
          houseLabel: e.propertyId ? ((await loadOwnedProperty(db, args.ownerUserId, e.propertyId))?.label ?? null) : null,
        })),
      );
    }
    return {
      suggestions,
      draft: draftRows.find((d) => d.mode === "draft") ?? null,
      reviewing: draftRows.find((d) => d.mode === "auto_review") ?? null,
    };
  } catch {
    return EMPTY;
  }
}
