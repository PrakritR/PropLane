/**
 * How a link sits inside a text. Pure.
 *
 * - Every link is on its own line, so a phone shows it as one tappable target and a trailing sentence
 *   cannot be swallowed into it.
 * - No punctuation is glued to the end of a link ("...l/abc." and "...l/abc)" both open a dead page on
 *   some phones). The punctuation is dropped from the link; a sentence that ended on it ends on the
 *   line above.
 * - A link to one of OUR pages always uses the canonical host (`https://proplane.ai/...`): a deploy
 *   preview, a `www.` host or a legacy host in a text is rewritten, never sent. A link to anywhere else
 *   is left as it is. A localhost link (dev) is left as it is.
 */

const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;
/** Nothing after the last link but sentence punctuation. */
const TRAILING_ONLY = /^[.,;:!?)\]}>'"\s]+$/;
/**
 * Characters that end a sentence or close a bracket, never a part of the address. Held as a set and
 * scanned backwards rather than matched with an end-anchored `/[...]+$/`: the text these links are cut
 * out of is message body a sender controls, and that pattern backtracks quadratically over a long run
 * of punctuation that never reaches the end of the string.
 */
const TRAILING = new Set([".", ",", ";", ":", "!", "?", ")", "]", "}", ">", "'", '"']);

/** Hosts that are PropLane's own pages under another name. */
function isOwnPageHost(host: string, canonicalHost: string): boolean {
  const h = host.toLowerCase();
  if (h === canonicalHost) return false;
  return h === `www.${canonicalHost}` || h.endsWith(".vercel.app") || /(^|\.)axis(housing)?\./.test(h);
}

export function trimLinkTail(url: string): { url: string; tail: string } {
  let end = url.length;
  while (end > 0 && TRAILING.has(url[end - 1]!)) end -= 1;
  if (end === url.length) return { url, tail: "" };
  return { url: url.slice(0, end), tail: url.slice(end) };
}

/** Rewrite one of our own non-canonical hosts onto the canonical origin; any other URL passes through. */
export function canonicalizeLinkHost(url: string, canonicalOrigin: string): string {
  try {
    const target = new URL(url);
    const canonical = new URL(canonicalOrigin);
    if (!isOwnPageHost(target.hostname, canonical.hostname)) return url;
    return `${canonical.origin}${target.pathname}${target.search}${target.hash}`;
  } catch {
    return url;
  }
}

/**
 * Put every link in `text` on its own line with no punctuation glued to it and its host canonical.
 * Text without a link comes back unchanged (only trimmed). Idempotent.
 */
export function formatSmsLinks(text: string, canonicalOrigin: string): string {
  const source = String(text ?? "");
  if (!/https?:\/\//i.test(source)) return source.trim();
  const parts: string[] = [];
  let cursor = 0;
  for (const match of source.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0;
    const before = source.slice(cursor, start).trim();
    if (before) parts.push(before);
    // The punctuation that was glued to the end of the address is dropped, not sent with it.
    parts.push(canonicalizeLinkHost(trimLinkTail(match[0]).url, canonicalOrigin));
    cursor = start + match[0].length;
  }
  const rest = source.slice(cursor).replace(TRAILING_ONLY, "").trim();
  if (rest) parts.push(rest);
  return parts.join("\n");
}
