import "server-only";

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { houseInfoEscalateAfter, type HouseInfoV1 } from "@/lib/house-info";
import { loadWorkspaceProperties } from "@/lib/one-number/knowledge/scope.server";
import { redactSensitiveNumbers } from "@/lib/one-number/redact";
import { normalizeConsentPhone } from "@/lib/sms-consent";
import {
  COMPLAINT_WINDOW_DAYS,
  complaintThresholdCrossed,
  maskPhoneTail,
  type EscalationItem,
  type EscalationSource,
  type EscalationStatus,
} from "./escalations";

/**
 * Read and resolve the manager's escalations. The rows are W6's `sms_escalated_questions` (an agent
 * handed a question to the team) plus the two sources this workstream adds: the house group's RA and
 * a question nobody answered. Every query is scoped to the workspace the signed-in actor is in;
 * a co-manager sees only the houses they hold.
 */

const GENERIC_TOPICS = new Set(["other", ""]);

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export async function listEscalations(
  db: SupabaseClient,
  input: {
    ownerUserId: string;
    workspaceId: string;
    status: EscalationStatus;
    /** Houses a non-owner may see; null for the owner (all houses, and rows with no house). */
    allowedPropertyIds: readonly string[] | null;
    limit?: number;
  },
): Promise<EscalationItem[]> {
  try {
    let query = db
      .from("sms_escalated_questions")
      .select("id, source, role, topic, question, excerpt, property_id, phone_key, escalated_at, resolved_at")
      .eq("workspace_id", input.workspaceId)
      .order("escalated_at", { ascending: false })
      .limit(input.limit ?? 100);
    query = input.status === "open" ? query.is("resolved_at", null) : query.not("resolved_at", "is", null);
    // Logged complaints below the threshold are bookkeeping, not an item to act on.
    query = query.neq("topic", "complaint");
    const { data, error } = await query;
    if (error) return [];
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    const visible = rows.filter((row) => {
      if (!input.allowedPropertyIds) return true;
      const propertyId = asString(row.property_id);
      return propertyId !== "" && input.allowedPropertyIds.includes(propertyId);
    });
    const houseIds = [...new Set(visible.map((r) => asString(r.property_id)).filter(Boolean))];
    const labels = new Map<string, string>();
    if (houseIds.length > 0) {
      const briefs = await loadWorkspaceProperties(db, input.ownerUserId, input.workspaceId, houseIds);
      for (const brief of briefs) labels.set(brief.id, brief.label);
    }
    return visible.map((row) => {
      const source = row.source === "ra" || row.source === "unanswered" ? (row.source as EscalationSource) : "agent";
      const question = asString(row.question);
      const propertyId = asString(row.property_id) || null;
      const topic = asString(row.topic);
      return {
        id: String(row.id),
        source,
        role: asString(row.role) || "resident",
        topic: GENERIC_TOPICS.has(topic) ? "" : topic,
        question,
        excerpt: asString(row.excerpt) || question,
        propertyId,
        houseLabel: propertyId ? (labels.get(propertyId) ?? null) : null,
        phoneTail: maskPhoneTail(asString(row.phone_key)),
        escalatedAt: String(row.escalated_at),
        resolvedAt: row.resolved_at ? String(row.resolved_at) : null,
      };
    });
  } catch {
    return [];
  }
}

export async function countOpenEscalations(
  db: SupabaseClient,
  input: { workspaceId: string; allowedPropertyIds: readonly string[] | null },
): Promise<number> {
  const items = await listEscalations(db, { ownerUserId: "", workspaceId: input.workspaceId, status: "open", allowedPropertyIds: input.allowedPropertyIds, limit: 200 });
  return items.length;
}

/** Mark one escalation handled. Scoped to the workspace and to the actor's houses; false when it is not theirs. */
export async function resolveEscalation(
  db: SupabaseClient,
  input: { workspaceId: string; id: string; userId: string; allowedPropertyIds: readonly string[] | null; reopen?: boolean },
): Promise<boolean> {
  try {
    const { data: row } = await db
      .from("sms_escalated_questions")
      .select("id, property_id")
      .eq("id", input.id)
      .eq("workspace_id", input.workspaceId)
      .maybeSingle();
    if (!row) return false;
    if (input.allowedPropertyIds) {
      const propertyId = asString((row as Record<string, unknown>).property_id);
      if (!propertyId || !input.allowedPropertyIds.includes(propertyId)) return false;
    }
    const { error } = await db
      .from("sms_escalated_questions")
      .update(
        input.reopen
          ? { resolved_at: null, resolved_by: null }
          : { resolved_at: new Date().toISOString(), resolved_by: input.userId },
      )
      .eq("id", input.id)
      .eq("workspace_id", input.workspaceId);
    return !error;
  } catch {
    return false;
  }
}

/**
 * File an escalation from a source other than the assistant tools (the house group's RA, a question
 * nobody answered). Text is redacted of card and bank numbers before it is stored. Best effort: a
 * failed write must never break the conversation that raised it.
 */
export async function recordEscalationItem(
  db: SupabaseClient,
  input: {
    workspaceId: string;
    ownerUserId: string;
    source: EscalationSource;
    phone: string;
    role?: "resident" | "applicant" | "prospect" | "vendor" | "manager";
    propertyId?: string | null;
    topic?: string;
    question: string;
    excerpt?: string;
    /** Already handled (a complaint logged below the threshold). */
    resolved?: boolean;
  },
): Promise<string | null> {
  try {
    const phoneKey = normalizeConsentPhone(input.phone);
    const question = redactSensitiveNumbers(input.question).text.trim().slice(0, 500);
    if (!question || !phoneKey) return null;
    const id = randomUUID();
    const excerpt = input.excerpt ? redactSensitiveNumbers(input.excerpt).text.trim().slice(0, 1200) : null;
    const { error } = await db.from("sms_escalated_questions").insert({
      id,
      workspace_id: input.workspaceId,
      owner_user_id: input.ownerUserId,
      phone_key: phoneKey,
      role: input.role ?? "resident",
      property_id: input.propertyId ?? null,
      topic: input.topic ?? "other",
      question,
      source: input.source,
      excerpt,
      ...(input.resolved ? { resolved_at: new Date().toISOString() } : {}),
    });
    return error ? null : id;
  } catch {
    return null;
  }
}

export type ComplaintOutcome = { logged: boolean; count: number; threshold: number | null; escalated: boolean };

/**
 * A complaint from a house group moves to one on one and is counted here. Under the threshold it is
 * logged and nothing reaches the inbox; the one that reaches the manager's number (House details,
 * Escalate after N complaints in 30 days) files one open "repeated complaints" item with the excerpt.
 * No punishment by AI: this only surfaces the pattern to the manager.
 */
export async function recordHouseComplaint(
  db: SupabaseClient,
  input: {
    workspaceId: string;
    ownerUserId: string;
    propertyId: string;
    phone: string;
    text: string;
    houseInfo: HouseInfoV1 | null | undefined;
    now?: Date;
  },
): Promise<ComplaintOutcome> {
  const threshold = houseInfoEscalateAfter(input.houseInfo);
  const logged = await recordEscalationItem(db, {
    workspaceId: input.workspaceId,
    ownerUserId: input.ownerUserId,
    source: "ra",
    phone: input.phone,
    propertyId: input.propertyId,
    topic: "complaint",
    question: input.text,
    resolved: true,
  });
  if (!logged) return { logged: false, count: 0, threshold, escalated: false };

  const since = new Date((input.now ?? new Date()).getTime() - COMPLAINT_WINDOW_DAYS * 86_400_000).toISOString();
  const { count } = await db
    .from("sms_escalated_questions")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", input.workspaceId)
    .eq("property_id", input.propertyId)
    .eq("topic", "complaint")
    .gte("escalated_at", since);
  const total = count ?? 1;
  if (!complaintThresholdCrossed(total, threshold)) return { logged: true, count: total, threshold, escalated: false };

  // One open "repeated complaints" item per window: later complaints do not stack another.
  const { data: existing } = await db
    .from("sms_escalated_questions")
    .select("id")
    .eq("workspace_id", input.workspaceId)
    .eq("property_id", input.propertyId)
    .eq("topic", "repeated_complaints")
    .is("resolved_at", null)
    .gte("escalated_at", since)
    .limit(1);
  if (existing && existing.length > 0) return { logged: true, count: total, threshold, escalated: false };
  const filed = await recordEscalationItem(db, {
    workspaceId: input.workspaceId,
    ownerUserId: input.ownerUserId,
    source: "ra",
    phone: input.phone,
    propertyId: input.propertyId,
    topic: "repeated_complaints",
    question: `${total} complaints in ${COMPLAINT_WINDOW_DAYS} days at this house`,
    excerpt: input.text,
  });
  return { logged: true, count: total, threshold, escalated: Boolean(filed) };
}
