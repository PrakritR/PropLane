import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { notifyManagerFromAgent } from "@/lib/agent-notify.server";
import { normalizeQuestionKey } from "./store.server";

/** `2026-W42`: one digest per workspace per ISO week. */
export function isoWeekKey(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export type UnansweredQuestion = { question: string; count: number };

/** Group by normalized question, most asked first. Pure. */
export function topUnanswered(questions: readonly string[], limit = 5): UnansweredQuestion[] {
  const groups = new Map<string, UnansweredQuestion>();
  for (const q of questions) {
    const key = normalizeQuestionKey(q);
    if (!key) continue;
    const existing = groups.get(key);
    if (existing) existing.count += 1;
    else groups.set(key, { question: q.trim(), count: 1 });
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.question.localeCompare(b.question)).slice(0, limit);
}

export function buildDigestText(items: readonly UnansweredQuestion[], awaitingSave: number): string {
  const lines = ["Questions the assistant could not answer this week:"];
  items.forEach((item, i) => lines.push(`${i + 1}. ${item.question}${item.count > 1 ? ` (${item.count} times)` : ""}`));
  if (awaitingSave > 0) lines.push("", `${awaitingSave} saved-answer suggestion${awaitingSave === 1 ? "" : "s"} waiting in Communication.`);
  lines.push("", "Answer them once and the assistant uses it next time.");
  return lines.join("\n");
}

/**
 * Weekly: each workspace's top unanswered questions (escalations with no approved entry) as one
 * Assistant notice to the workspace owner. Idempotent per workspace per week.
 */
export async function runWeeklyKnowledgeDigest(
  db: SupabaseClient,
  now: Date = new Date(),
): Promise<{ sent: number; skipped: number }> {
  let sent = 0;
  let skipped = 0;
  const weekKey = isoWeekKey(now);
  const since = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const { data, error } = await db
    .from("sms_escalated_questions")
    .select("workspace_id, owner_user_id, question, entry_id")
    .gte("escalated_at", since)
    .limit(5000);
  if (error) return { sent, skipped };
  const byWorkspace = new Map<string, { owner: string; rows: { question: string; entryId: string | null }[] }>();
  for (const row of (data ?? []) as { workspace_id: string; owner_user_id: string; question: string; entry_id: string | null }[]) {
    const bucket = byWorkspace.get(row.workspace_id) ?? { owner: row.owner_user_id, rows: [] };
    bucket.rows.push({ question: row.question, entryId: row.entry_id });
    byWorkspace.set(row.workspace_id, bucket);
  }
  for (const [workspaceId, bucket] of byWorkspace) {
    try {
      const entryIds = bucket.rows.map((r) => r.entryId).filter((id): id is string => Boolean(id));
      const approved = new Set<string>();
      if (entryIds.length) {
        const { data: entries } = await db
          .from("property_knowledge_entries")
          .select("id, status")
          .eq("workspace_id", workspaceId)
          .in("id", entryIds);
        for (const e of (entries ?? []) as { id: string; status: string }[]) if (e.status === "approved") approved.add(e.id);
      }
      const unanswered = bucket.rows.filter((r) => !r.entryId || !approved.has(r.entryId)).map((r) => r.question);
      if (unanswered.length === 0) {
        skipped += 1;
        continue;
      }
      const { data: already } = await db
        .from("sms_knowledge_digests")
        .select("week_key")
        .eq("workspace_id", workspaceId)
        .eq("week_key", weekKey)
        .maybeSingle();
      if (already) {
        skipped += 1;
        continue;
      }
      const awaitingSave = bucket.rows.filter((r) => r.entryId && !approved.has(r.entryId)).length;
      const text = buildDigestText(topUnanswered(unanswered), awaitingSave);
      await notifyManagerFromAgent(db, {
        landlordId: bucket.owner,
        subject: "Unanswered questions this week",
        text,
        threadType: "knowledge_weekly_digest",
        url: "/portal/communication",
        notify: { push: true, sms: false },
        idempotencyKey: `knowledge-digest:${workspaceId}:${weekKey}`,
        workspaceId,
      });
      await db.from("sms_knowledge_digests").insert({ workspace_id: workspaceId, week_key: weekKey });
      sent += 1;
    } catch (cause) {
      console.error("knowledge digest failed", workspaceId, cause instanceof Error ? cause.message : "unknown");
      skipped += 1;
    }
  }
  return { sent, skipped };
}
