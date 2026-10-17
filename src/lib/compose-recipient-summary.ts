/**
 * The "Recipients" line on New message's left card and in its preview: the
 * people picked from the list followed by the addresses and numbers typed in as
 * chips. Typed recipients used to be left out, so the card read "Not selected"
 * while the To field already showed them.
 */
export function composeRecipientSummary(
  pickedLabels: readonly string[],
  typedTokens: readonly { label: string }[],
): string {
  return [...pickedLabels, ...typedTokens.map((token) => token.label)]
    .map((label) => label.trim())
    .filter(Boolean)
    .join(", ");
}
