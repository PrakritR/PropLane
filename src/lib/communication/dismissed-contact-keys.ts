/**
 * The shared shape of a dismissed-contact key (`communication_dismissed_contacts`),
 * used by both the server route and the browser client so the two cannot drift.
 *
 * `DISMISSED_CONTACT_KEYS_PER_CALL` is one request's worth. The client sends
 * long lists (Delete all archived) in batches of this size and the route refuses
 * a bigger one: a batch that was silently truncated reported every key as saved
 * and the rest of the rows came back on the next load.
 */

export const DISMISSED_CONTACT_KEYS_PER_CALL = 200;

const MAX_KEY_LENGTH = 320;

/** The directory's own key for a person: the trimmed, lower-cased email. */
export function normalizeDismissedContactKey(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** A well-formed key, or "" — the directory keys people by email address. */
export function validDismissedContactKey(value: unknown): string {
  const key = normalizeDismissedContactKey(value);
  return key && key.length <= MAX_KEY_LENGTH && key.includes("@") ? key : "";
}

/** Split keys into requests of at most `DISMISSED_CONTACT_KEYS_PER_CALL`. */
export function chunkDismissedContactKeys(keys: readonly string[]): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < keys.length; i += DISMISSED_CONTACT_KEYS_PER_CALL) {
    chunks.push(keys.slice(i, i + DISMISSED_CONTACT_KEYS_PER_CALL));
  }
  return chunks;
}
