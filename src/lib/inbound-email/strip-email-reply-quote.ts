/**
 * Trim quoted history from an email reply so the chat bubble carries only the
 * new text: drop everything from the first quote marker ("On … wrote:",
 * "-----Original Message-----", a From:-header block) and any `>`-quoted
 * lines. Heuristic on purpose — when stripping would empty the body, the full
 * body is kept rather than losing the reply.
 *
 * Client-safe: the thread UI strips on display so a stored Gmail quote block
 * never paints. Ingest uses the same helper.
 */
export function stripEmailReplyQuote(body: string): string {
  const lines = body.split("\n");
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (
      isWrappedAttributionHeader(lines, index) ||
      /^-{2,}\s*Original Message\s*-{2,}$/i.test(trimmed) ||
      /^-{2,}\s*Forwarded message\s*-{2,}$/i.test(trimmed) ||
      /^From:\s.+@.+/i.test(trimmed)
    ) {
      break;
    }
    if (trimmed.startsWith(">")) continue;
    kept.push(line);
  }
  const stripped = kept.join("\n").trim();
  return stripped || body.trim();
}

/**
 * "On <date> <name> <address> wrote:" — Gmail and Apple Mail's attribution line.
 *
 * Gmail hard-wraps that line when the name plus address run long, so the
 * `wrote:` lands on the SECOND (occasionally third) physical line:
 *
 *     On Tue, Sep 15, 2026 at 2:29 AM Prakrit Ramachandran <
 *     prakritramachandran@gmail.com> wrote:
 *
 * A single-line test never fires on that, and the header — the one line the
 * `>` filter cannot catch — used to survive into the chat bubble. Read up to
 * three lines from an `On ` opener and accept when the joined text closes with
 * `wrote:`. A sentence that merely starts with "On" ("On Friday I can do 3pm")
 * never ends in `wrote:` and is kept.
 */
function isWrappedAttributionHeader(lines: string[], index: number): boolean {
  const first = (lines[index] ?? "").trim();
  if (!/^(?:>\s*)?On\s/.test(first)) return false;
  let joined = first.replace(/^>\s*/, "");
  for (let extra = 0; extra < 3; extra += 1) {
    if (/\swrote:\s*$/.test(joined) && joined.length <= 240) return true;
    const next = (lines[index + 1 + extra] ?? "").trim().replace(/^>\s*/, "");
    if (!next) return false;
    joined = `${joined} ${next}`;
  }
  return false;
}

/** True when the body still carries a Gmail/Outlook quote block (unstamped historical mail). */
export function looksLikeEmailQuoteBlock(body: string): boolean {
  const text = body.trim();
  if (!text) return false;
  if (/\swrote:\s*$/m.test(text)) return true;
  if (/^-{2,}\s*(Original Message|Forwarded message)\s*-{2,}$/im.test(text)) return true;
  return false;
}
