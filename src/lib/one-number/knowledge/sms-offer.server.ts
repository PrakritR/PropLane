import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { notifyManagerFromAgent } from "@/lib/agent-notify.server";
import { createPendingActionForUser } from "@/lib/tools/pending-actions";
import { resolveOpenSmsProposal } from "@/lib/sms/agent-confirmation.server";
import { loadSharedLineConfig } from "../config.server";
import type { KnowledgeEntry } from "./types";

const OFFER_TTL_MS = 24 * 60 * 60 * 1000;
const SAVE_TOOL = "save_knowledge_answer";

/** The text itself: one segment, no emoji, no long dashes. */
export function buildSaveOfferText(houseLabel: string | null): string {
  const label = (houseLabel ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
  return label ? `Save this answer for ${label}? Reply YES.` : "Save this answer for this house? Reply YES.";
}

/**
 * After a manager answered an escalation, ask them by text to save it. The confirmation rides the
 * existing YES gate: a `save_knowledge_answer` pending action in their Assistant session, which the
 * manager SMS agent confirms before any model call. Only offered when no other proposal is open
 * (a bare YES must stay unambiguous) and, unless forced, only once the one-number line is on.
 */
export async function offerSaveBySms(
  db: SupabaseClient,
  args: { ownerUserId: string; actorUserId: string; entry: KnowledgeEntry; houseLabel: string | null; force?: boolean },
): Promise<"offered" | "skipped"> {
  try {
    if (!args.force && process.env.ONE_NUMBER_KNOWLEDGE_SMS_OFFER !== "1") {
      const config = await loadSharedLineConfig(db);
      if (config.mode === "per_workspace") return "skipped";
    }
    const { findOrCreatePortalAssistantSmsSession } = await import("@/lib/agent/sms-agent-turn.server");
    const session = await findOrCreatePortalAssistantSmsSession(db, {
      actorUserId: args.actorUserId,
      workspaceId: args.entry.workspaceId,
    });
    if (!session) return "skipped";
    const open = await resolveOpenSmsProposal(db, { userId: args.actorUserId, sessionId: session.id, portal: "manager" });
    if (open.status !== "none") return "skipped";

    const actionId = await createPendingActionForUser(db, {
      landlordId: args.ownerUserId,
      userId: args.actorUserId,
      toolName: SAVE_TOOL,
      input: { entryId: args.entry.id, scope: args.entry.propertyId ? "house" : "team" },
      preview: {
        kind: SAVE_TOOL,
        title: "Save this answer",
        confirmLabel: "Save answer",
        fields: [
          { label: "Question", value: args.entry.question },
          { label: "Answer", value: args.entry.answer },
        ],
      },
      portal: "manager",
      sessionId: session.id,
      expiresInMs: OFFER_TTL_MS,
    });
    if (!actionId) return "skipped";

    const text = buildSaveOfferText(args.houseLabel);
    await notifyManagerFromAgent(db, {
      landlordId: args.actorUserId,
      subject: "Save this answer?",
      text: `${text}\n\nQuestion: ${args.entry.question}\nAnswer: ${args.entry.answer}`,
      externalText: text,
      threadType: "knowledge_save_offer",
      notify: { push: false, sms: true },
      idempotencyKey: `knowledge-save:${args.entry.id}`,
      workspaceId: args.entry.workspaceId,
      senderOwnerId: args.actorUserId === args.ownerUserId ? null : args.ownerUserId,
    });
    return "offered";
  } catch (error) {
    console.error("knowledge save offer failed", error instanceof Error ? error.message : "unknown");
    return "skipped";
  }
}
