import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { notifyManagerFromAgent } from "@/lib/agent-notify.server";
import { RESIDENT_HANDOFF_NOTICE_TYPE, RESIDENT_HANDOFF_SUBJECT } from "@/lib/resident-handoff";

/**
 * "Resident asked for you": the manager's Needs-attention item for a resident who used the in-app assistant to message
 * them. It rides the existing manager-notice source (`notifyManagerFromAgent`, the one `escalate_to_manager` uses): one
 * idempotent message in the manager's PropLane Assistant thread stamped `noticeType: resident_handoff`, plus a push. The
 * queue counts it while that thread is unread (`countResidentHandoffs`), so it clears when the manager reads or replies.
 *
 * Called only AFTER the resident's message was delivered, with managers already resolved from the resident's own scope.
 * Returns true only when at least one notice was written, which is the only thing the assistant may call "notified".
 * Never throws: the message itself already went out.
 */
export async function recordResidentHandoff(
  db: SupabaseClient,
  input: { managerUserIds: string[]; residentUserId: string; residentName: string; subject: string; messageHash: string; dayBucket: string },
): Promise<boolean> {
  let notified = false;
  for (const managerId of [...new Set(input.managerUserIds.map((id) => id.trim()).filter(Boolean))]) {
    try {
      const name = input.residentName.trim() || "A resident";
      const result = await notifyManagerFromAgent(db, {
        landlordId: managerId,
        subject: RESIDENT_HANDOFF_SUBJECT,
        text: `${name} asked for you in the PropLane assistant: "${input.subject.trim().slice(0, 120)}". Their message is in your inbox.`,
        externalText: RESIDENT_HANDOFF_SUBJECT,
        threadType: RESIDENT_HANDOFF_NOTICE_TYPE,
        url: "/portal/communication/active",
        category: "messages",
        notify: { push: true, sms: false },
        idempotencyKey: `resident-handoff:${createHash("sha256").update(`${input.residentUserId}:${managerId}:${input.messageHash}:${input.dayBucket}`).digest("hex").slice(0, 32)}`,
      });
      if (result.delivered && !result.suppressed) notified = true;
    } catch (error) {
      console.error("resident handoff notice failed", error instanceof Error ? error.message : "unknown");
    }
  }
  return notified;
}
