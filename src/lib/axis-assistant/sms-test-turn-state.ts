import type { SmsTestTurnMetadata } from "@/lib/axis-assistant/use-assistant-conversation";

/** Discards a prior SMS test turn after the selected target or chat session changes. */
export function currentSmsTestTurn(
  turn: SmsTestTurnMetadata | null,
  targetListingId: string | null | undefined,
  sessionId: string,
): SmsTestTurnMetadata | null {
  if (!turn) return null;
  if (turn.sessionId !== sessionId) return null;

  // Manager turns intentionally have no selected listing. The API serializes
  // that absence as null while the control stores it as an empty string.
  if (turn.mode === "manager") {
    const turnTarget = turn.targetListingId?.trim() || "";
    const selectedTarget = targetListingId?.trim() || "";
    return turnTarget === selectedTarget ? turn : null;
  }

  // Resident/prospect turns are listing-scoped. Preserve exact identity
  // matching so an absent target cannot match an empty or different target.
  return turn.targetListingId === targetListingId ? turn : null;
}
