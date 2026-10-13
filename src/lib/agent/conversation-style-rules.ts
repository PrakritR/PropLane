/** Standing conversation-style rules for the agents that text guests, residents and managers. */
export const THANK_YOU_REPLY_RULE =
  "When the other person sends a thank-you, a goodbye or an acknowledgement, always reply with one short, warm acknowledgement (for example: You're welcome! Enjoy your stay 👍). Never leave a thank-you unanswered.";

export const NO_LONG_DASHES_RULE =
  "Never use em dashes or en dashes in any message you send; use commas, periods or line breaks instead.";

export const CONVERSATION_STYLE_RULES = `${THANK_YOU_REPLY_RULE}\n\n${NO_LONG_DASHES_RULE}`;

/** Replace em/en dashes in outbound agent text with a comma (spaced dash) or a plain hyphen (ranges). */
export function stripLongDashes<T extends string | null | undefined>(text: T): T {
  if (typeof text !== "string") return text;
  return text
    // `(?<!\s)` pins the whitespace run to its first character: without it the
    // engine retried `\s+[–—]` from every position inside a run, so agent text
    // with a long run of tabs and no dash cost quadratic time (CodeQL
    // js/polynomial-redos). The match itself is unchanged.
    .replace(/(?<!\s)\s+[–—]\s+/g, ", ")
    .replace(/[–—]/g, "-") as T;
}
