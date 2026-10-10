/**
 * What a text from a workspace member to the work number means.
 *
 * A member who texts the work number is talking to the team, unless the text
 * starts with an assistant address: "@assistant", "assistant," / "assistant:"
 * or "@ai" (any case). That one goes to the PropLane Assistant, with the
 * address stripped, and the answer goes to the asker alone. Pure.
 */
const ASSISTANT_PREFIX = /^\s*(?:@assistant\b|assistant\s*[,:]|@ai\b)[\s,:;-]*/i;

export function startsWithAssistantAddress(body: string): boolean {
  return ASSISTANT_PREFIX.test(body);
}

/** The text without its assistant address; the original (trimmed) when there is none or nothing follows it. */
export function stripAssistantAddress(body: string): string {
  const stripped = body.replace(ASSISTANT_PREFIX, "").trim();
  return stripped || body.trim();
}
