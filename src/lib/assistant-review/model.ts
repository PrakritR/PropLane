/**
 * Assistant quality management on a conversation (client-safe, pure).
 *
 * A manager or admin reads what the PropLane Assistant said in a conversation and can: FLAG a reply (with a reason),
 * CORRECT it (write what the answer should have been), PAUSE the assistant on that one conversation, RESUME it, or TAKE OVER
 * (pause + focus the composer). Every row is workspace-scoped; a correction is house knowledge the assistant reads through
 * `lookup_property_knowledge`, never an instruction it executes.
 */

export const REVIEW_KINDS = ["flag", "correction", "pause"] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];

export const REVIEW_REASON_MAX = 500;
export const REVIEW_CORRECTION_MAX = 1200;
export const REVIEW_AGENT_TEXT_MAX = 2000;

/** The label every assistant turn wears in a thread. */
export const ASSISTANT_TURN_LABEL = "PropLane Assistant";

/** A conversation id, `sms:<phone key>`, `web:<session>` or a conversation key. Never a path, query or whitespace. */
const KEY = /^[A-Za-z0-9][A-Za-z0-9:_.@+-]{0,199}$/;

export function isReviewThreadKey(value: unknown): value is string {
  return typeof value === "string" && KEY.test(value.trim());
}

export type AssistantReviewRow = {
  id: string;
  workspaceId: string;
  threadKey: string;
  kind: ReviewKind;
  messageRef: string | null;
  reason: string | null;
  body: string | null;
  agentText: string | null;
  knowledgeEntryId: string | null;
  createdAt: string;
  resolvedAt: string | null;
};

export type ThreadReviewState = {
  paused: boolean;
  flags: AssistantReviewRow[];
  corrections: AssistantReviewRow[];
};

export function emptyReviewState(): ThreadReviewState {
  return { paused: false, flags: [], corrections: [] };
}

/** Does this message ref carry a flag or a correction already? Drives the quiet "Flagged" / "Corrected" marks. */
export function reviewMarksFor(state: ThreadReviewState, messageRef: string): { flagged: boolean; corrected: boolean } {
  const ref = messageRef.trim();
  return {
    flagged: state.flags.some((row) => !row.resolvedAt && row.messageRef === ref),
    corrected: state.corrections.some((row) => row.messageRef === ref),
  };
}

export type ReviewAuditAction = "assistant_reply_flag" | "assistant_reply_correct" | "assistant_thread_pause" | "assistant_thread_resume";

export function cleanText(value: unknown, max: number): string {
  return (typeof value === "string" ? value : "").replace(/\s+/g, " ").trim().slice(0, max);
}

/** The conversation key for a text thread: the person's last ten digits. The SMS inbound path checks the same key. */
export function smsReviewThreadKey(phone: string | null | undefined): string | null {
  const digits = String(phone ?? "").replace(/\D/g, "").slice(-10);
  return digits.length === 10 ? `sms:${digits}` : null;
}

export function phoneKeyFromReviewThreadKey(threadKey: string): string | null {
  const match = /^sms:(\d{10})$/.exec(threadKey);
  return match ? match[1]! : null;
}

/**
 * The review key for an in-app thread row: a text-origin conversation (`tel:+1206...`) is the SAME conversation as the text
 * stream's `sms:<10 digits>` (the inbound pipeline checks that key), every other thread goes by its conversation key, else its id.
 */
export function reviewKeyForThread(thread: { conversationKey?: string | null; id: string }): string {
  const key = (thread.conversationKey ?? "").trim();
  const tel = /^tel:\+?\d*?(\d{10})$/.exec(key);
  if (tel) return `sms:${tel[1]}`;
  return key || thread.id;
}
