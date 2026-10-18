import "server-only";

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeConsentPhone } from "@/lib/sms-consent";
import type { SharedLineRole } from "../contracts";
import { isMissingSchemaError } from "../config.server";
import { createEntry } from "./store.server";
import { classifyTopic, normalizeTopic } from "./topics";
import { recordReplyOutcome } from "./outcomes.server";
import { defaultWorkspaceIdFor, loadOwnedProperty } from "./scope.server";
import type { KnowledgeEntry } from "./types";

/** An escalation older than this is a different conversation. */
export const ESCALATION_CAPTURE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** A reply worth keeping as an answer: more than an acknowledgement. */
export function isCapturableAnswer(text: string): boolean {
  const body = text.trim();
  if (body.length < 12) return false;
  if (body.split(/\s+/).length < 3) return false;
  if (/^(ok|okay|thanks|thank you|got it|sounds good|will do|on my way)[.! ]*$/i.test(body)) return false;
  return true;
}

function sameText(a: string, b: string): boolean {
  const norm = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim();
  return norm(a) === norm(b);
}

/**
 * Remember that an agent handed a texter's question to the team. Best effort: an escalation must
 * never fail because the learning loop could not write. The workspace is the house's, else the
 * owner's default.
 */
export async function recordEscalatedQuestion(
  db: SupabaseClient,
  args: {
    ownerUserId: string;
    phone: string;
    role: SharedLineRole;
    question: string;
    propertyId?: string | null;
    workspaceId?: string | null;
  },
): Promise<void> {
  try {
    const question = args.question.trim().slice(0, 500);
    const phoneKey = normalizeConsentPhone(args.phone);
    if (!question || !phoneKey || !args.ownerUserId.trim()) return;
    const property = args.propertyId ? await loadOwnedProperty(db, args.ownerUserId, args.propertyId) : null;
    const workspaceId = args.workspaceId || property?.workspaceId || (await defaultWorkspaceIdFor(db, args.ownerUserId));
    if (!workspaceId) return;
    const { error } = await db.from("sms_escalated_questions").insert({
      id: randomUUID(),
      workspace_id: workspaceId,
      owner_user_id: args.ownerUserId,
      phone_key: phoneKey,
      role: args.role,
      property_id: property?.id ?? null,
      topic: classifyTopic(question),
      question,
      escalated_at: new Date().toISOString(),
    });
    if (error && !isMissingSchemaError(error)) console.error("escalated question insert failed", error.message);
    if (!error) {
      // The unanswerable-question alert: the escalation tool told the owner; the listed alert phones hear it here.
      const { alertPhonesOf } = await import("@/lib/one-number/ops-alerts.server");
      await alertPhonesOf(db, {
        ownerUserId: args.ownerUserId,
        workspaceId,
        propertyId: property?.id ?? null,
        kind: "unanswered_question",
        entityId: `${workspaceId}:${phoneKey}:${question.slice(0, 40)}`,
        text: `A ${args.role} asked something I could not answer: ${question.slice(0, 90)}`,
      });
    }
  } catch {
    /* best effort */
  }
}

export type CaptureResult =
  | { captured: false }
  | { captured: true; entry: KnowledgeEntry; via: "escalation" | "draft_edit"; houseLabel: string | null };

/**
 * A manager just sent `text` to `toPhone`. If that answers an escalated question, or edits an AI
 * draft held for this person, file a SUGGESTED entry. Nothing a texter says becomes an answer
 * until a manager approves it, and this only ever writes `suggested`.
 */
export async function captureFromManagerSend(
  db: SupabaseClient,
  args: { ownerUserId: string; actorUserId: string; toPhone: string; text: string },
): Promise<CaptureResult> {
  try {
    const phoneKey = normalizeConsentPhone(args.toPhone);
    const text = args.text.trim();
    if (!phoneKey || !text) return { captured: false };

    // 1. A held AI draft for this person: sent as written, or edited first.
    const { data: draftRow, error: draftError } = await db
      .from("sms_ai_reply_drafts")
      .select("id, workspace_id, topic, mode, inbound_text, body, property_id, status")
      .eq("owner_user_id", args.ownerUserId)
      .eq("phone_key", phoneKey)
      .eq("status", "pending")
      .eq("mode", "draft")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (draftError && !isMissingSchemaError(draftError)) console.error("draft lookup failed", draftError.message);
    if (draftRow) {
      const draft = draftRow as Record<string, unknown>;
      const workspaceId = String(draft.workspace_id);
      const topic = normalizeTopic(draft.topic);
      const mode = draft.mode === "auto_review" ? "auto_review" : "draft";
      const asIs = sameText(String(draft.body), text);
      await db
        .from("sms_ai_reply_drafts")
        .update({ status: asIs ? "sent" : "edited_sent", sent_text: text, decided_at: new Date().toISOString() })
        .eq("id", String(draft.id))
        .eq("workspace_id", workspaceId);
      await recordReplyOutcome(db, {
        workspaceId,
        topic,
        mode,
        outcome: asIs ? "sent_as_is" : "edited",
        turnRef: String(draft.id),
      });
      if (!asIs && isCapturableAnswer(text)) {
        const created = await createEntry(db, {
          workspaceId,
          propertyId: draft.property_id ? String(draft.property_id) : null,
          topic,
          question: String(draft.inbound_text),
          answer: text,
          status: "suggested",
          source: "draft_edit",
          sourceRef: String(draft.id),
          createdBy: args.actorUserId,
        });
        if (created.ok && !created.duplicate) {
          const house = created.entry.propertyId ? await loadOwnedProperty(db, args.ownerUserId, created.entry.propertyId) : null;
          return { captured: true, entry: created.entry, via: "draft_edit", houseLabel: house?.label ?? null };
        }
      }
      return { captured: false };
    }

    // 2. An escalated question this person is still waiting on.
    if (!isCapturableAnswer(text)) return { captured: false };
    const since = new Date(Date.now() - ESCALATION_CAPTURE_WINDOW_MS).toISOString();
    const { data: escRow, error: escError } = await db
      .from("sms_escalated_questions")
      .select("id, workspace_id, property_id, topic, question, role")
      .eq("owner_user_id", args.ownerUserId)
      .eq("phone_key", phoneKey)
      .is("resolved_at", null)
      .gte("escalated_at", since)
      .order("escalated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (escError || !escRow) return { captured: false };
    const esc = escRow as Record<string, unknown>;
    const created = await createEntry(db, {
      workspaceId: String(esc.workspace_id),
      propertyId: esc.property_id ? String(esc.property_id) : null,
      topic: normalizeTopic(esc.topic),
      question: String(esc.question),
      answer: text,
      status: "suggested",
      source: "manager_answer",
      sourceRef: String(esc.id),
      // What a prospect or vendor may be told is a separate, deliberate choice at approval.
      audience: "residents",
      createdBy: args.actorUserId,
    });
    await db
      .from("sms_escalated_questions")
      .update({ resolved_at: new Date().toISOString(), entry_id: created.ok ? created.entry.id : null })
      .eq("id", String(esc.id))
      .eq("workspace_id", String(esc.workspace_id));
    if (!created.ok || created.duplicate) return { captured: false };
    const house = created.entry.propertyId ? await loadOwnedProperty(db, args.ownerUserId, created.entry.propertyId) : null;
    return { captured: true, entry: created.entry, via: "escalation", houseLabel: house?.label ?? null };
  } catch (error) {
    console.error("knowledge capture failed", error instanceof Error ? error.message : "unknown");
    return { captured: false };
  }
}
