/**
 * Who wrote an outbound work-number text, carried in `sms_outbox.dedupe_key`'s prefix because the row has no author
 * column. `manager:` is a text a PERSON typed (or composed and scheduled) in the Communication inbox; `assistant:` is
 * one the assistant or an automation wrote, including a draft the manager confirmed. Read them back to tell a
 * manager's own reply from the assistant's (a resident's conversation labels the second one "PropLane"), and to find a
 * manager's prior vendor text.
 *
 * `sendManagerConversationSms` is the one writer of both: it takes the author explicitly, so a new caller has to say
 * which it is rather than inheriting a person's name.
 */
export type SendAuthor = "manager" | "assistant";

/** A text a person typed in the Communication inbox. */
export const MANAGER_SEND_DEDUPE_PREFIX = "manager:";

/** A text the assistant, an agent, a reminder, a welcome or a router wrote. */
export const ASSISTANT_SEND_DEDUPE_PREFIX = "assistant:";

/** Every prefix `sendManagerConversationSms` writes, for a reader that wants any send of either author. */
export const SEND_DEDUPE_PREFIXES: readonly string[] = [MANAGER_SEND_DEDUPE_PREFIX, ASSISTANT_SEND_DEDUPE_PREFIX];

export function sendDedupePrefix(author: SendAuthor): string {
  return author === "assistant" ? ASSISTANT_SEND_DEDUPE_PREFIX : MANAGER_SEND_DEDUPE_PREFIX;
}
