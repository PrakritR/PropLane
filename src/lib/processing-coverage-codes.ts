/**
 * Processing coverage codes — the client-safe half.
 *
 * The codes THEMSELVES live in `processing-coverage-codes.server.ts` and are
 * never bundled: they are credentials, and one of them was verifiably sitting
 * in a browser chunk, readable by any manager with devtools. This module holds
 * only what the browser legitimately needs — how to normalize what someone
 * typed, and whether it is the right SHAPE to be worth sending.
 *
 * Shape is not validity. A well-formed code still has to be checked by the
 * server (`POST /api/portal/verify-coverage-code`), which is the only place
 * that knows the answer.
 */

/** Upper-case, strip anything that is not a letter or digit. */
export function normalizeProcessingCoverageCode(code: string | null | undefined): string {
  return String(code ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

/**
 * Could this be a coverage code at all?
 *
 * Used only to decide whether to bother asking the server and to keep the
 * field from submitting obvious noise. It deliberately tells the caller nothing
 * about which codes are real — answering that in the browser is the bug this
 * split exists to fix.
 */
export function isProcessingCoverageCodeShape(code: string | null | undefined): boolean {
  const normalized = normalizeProcessingCoverageCode(code);
  return normalized.length >= 4 && normalized.length <= 32;
}
