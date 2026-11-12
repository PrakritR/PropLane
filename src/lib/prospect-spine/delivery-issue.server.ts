import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DeliveryIssueInput } from "@/lib/prospect-spine/contracts";
import { mergeThreadRowData, readThread } from "@/lib/prospect-spine/thread.server";

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());

/** Scrub a reason to a sentence a person can read: no phone numbers, no ids, no long digit runs. */
function cleanReason(reason: string): string {
  return reason
    .replace(/\+?\d[\d\s().-]{6,}\d/g, "[number]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[id]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

/**
 * Stamp `row_data.deliveryIssue = { at, direction, reason, messageId }` on the thread so the inbox shows it (the Filter's
 * "Delivery issues" and the failed bubble's "Not sent" line). With no thread (an inbound that never routed) it raises ONE
 * Attention item for the platform service owner instead. NEVER throws: it runs on failure paths.
 */
export async function recordDeliveryIssue(db: SupabaseClient, input: DeliveryIssueInput): Promise<void> {
  try {
    const reason = cleanReason(input.reason) || "A message could not be delivered.";
    const threadId = str(input.threadId);
    if (threadId) {
      const thread = await readThread(db, threadId);
      if (thread?.ownerUserId) {
        const written = await mergeThreadRowData(db, {
          threadId,
          ownerUserId: thread.ownerUserId,
          patch: {
            deliveryIssue: {
              at: new Date().toISOString(),
              direction: input.direction,
              reason,
              ...(str(input.messageId) ? { messageId: str(input.messageId) } : {}),
            },
            unread: true,
          },
        });
        if (written) return;
      }
    }
    const { serviceAlertPayerUserId } = await import("@/lib/service/service-alert-targets.server");
    const owner = await serviceAlertPayerUserId(db);
    if (!owner) return;
    const { notifyManagerFromAgent } = await import("@/lib/agent-notify.server");
    await notifyManagerFromAgent(db, {
      landlordId: owner,
      subject: input.direction === "inbound" ? "A text did not reach the inbox" : "A reply was not delivered",
      text: reason,
      threadType: "attention",
      category: "messages",
      notify: { push: true, sms: false },
      idempotencyKey: `delivery-issue:${str(input.eventId).slice(0, 120)}`,
      url: "/admin/service",
    });
  } catch {
    console.error("delivery issue not recorded");
  }
}

/** A later delivered send clears the thread's issue. Never throws. */
export async function clearDeliveryIssue(db: SupabaseClient, threadId: string): Promise<void> {
  try {
    const id = str(threadId);
    if (!id) return;
    const thread = await readThread(db, id);
    if (!thread?.ownerUserId || !thread.rowData.deliveryIssue) return;
    await mergeThreadRowData(db, { threadId: id, ownerUserId: thread.ownerUserId, remove: ["deliveryIssue"] });
  } catch {
    /* advisory */
  }
}

/** What a person on the platform can read for each way an inbound envelope ends in review. No ids, no numbers. */
const ENVELOPE_REASON_TEXT: Record<string, string> = {
  delivery_unknown: "A reply to a text may not have been delivered: the carrier did not confirm it.",
  reply_blocked: "A reply to a text could not be sent (the sender is blocked or the line is not ready).",
  sid_conflict: "A reply to a text could not be matched to the carrier's record.",
  uncertain_effect: "A text arrived but PropLane could not tell whether it was fully handled.",
  delegated_receipt: "A text arrived and its reply is waiting for a person to check it.",
  retry_exhausted: "A text arrived but PropLane could not process it after several tries.",
};

/**
 * An inbound envelope ended `needs_review`: raise ONE Attention item (idempotent on the envelope) so the failure is visible
 * instead of silent. Never throws.
 */
export async function reportEnvelopeIssue(db: SupabaseClient, envelopeId: string, reason: string): Promise<void> {
  await recordDeliveryIssue(db, {
    threadId: null,
    workspaceId: null,
    direction: "inbound",
    reason: ENVELOPE_REASON_TEXT[reason] ?? "A text could not be fully handled and needs a person to check it.",
    eventId: `envelope:${str(envelopeId)}:${str(reason)}`,
  });
}
