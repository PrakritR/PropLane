/**
 * The ONE envelope for text PropLane did not write.
 *
 * Tenant, vendor, applicant, channel-feed, spreadsheet and web-search text is
 * the classic prompt-injection carrier, so every read tool returns it fenced as
 * quoted data: `<<<EXTERNAL_<KIND> from <source>>>> … <<<END EXTERNAL_<KIND>>>>`.
 *
 * The fence only holds if the content cannot forge it, so both the source label
 * and the body are defused first: a zero-width space after every `<` and `>`
 * means no three-character delimiter can survive inside them, whatever the
 * author typed (`<<<<`, `>>>>>`, a pasted closing marker). It is deliberately
 * not a replace-the-delimiter pass — those regenerate the very sequence they
 * remove when the run is longer than three characters.
 */

const ZERO_WIDTH_SPACE = "​";

/** Break every `<`/`>` run so a delimiter can never appear inside wrapped text. */
export function defuseUntrustedDelimiters(text: string): string {
  return text.replace(/[<>]/g, (char) => `${char}${ZERO_WIDTH_SPACE}`);
}

/**
 * Wrap third-party text as quoted data. `kind` names the envelope
 * (`MESSAGE`, `SMS`, `SPREADSHEET`, …); `source` is who wrote it, omitted when
 * there is nothing meaningful to name.
 */
export function wrapUntrustedContent(
  kind: string,
  source: string | null | undefined,
  text: string,
): { untrustedContent: string } {
  const label = `EXTERNAL_${kind}`;
  const from = (source ?? "").trim();
  const attribution = from ? ` from ${defuseUntrustedDelimiters(from)}` : "";
  return {
    untrustedContent: `<<<${label}${attribution}>>> ${defuseUntrustedDelimiters(text)} <<<END ${label}>>>`,
  };
}
