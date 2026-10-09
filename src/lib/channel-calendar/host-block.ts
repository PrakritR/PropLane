/**
 * A host's own calendar block, as a channel exports it ("Airbnb (Not available)"), is not a
 * reservation: no guest holds the bed. It still closes the dates on the channel, so the Bookings
 * calendar shows it as a block, but it must never count toward room capacity or be exported back.
 * "Reserved" is a real booking and is deliberately NOT matched here.
 */
const HOST_BLOCK_SUMMARY = /not available|^blocked$|^unavailable$/i;

export function isHostBlockSummary(summary: string | null | undefined): boolean {
  return HOST_BLOCK_SUMMARY.test(String(summary ?? "").trim());
}

/** The stored flag wins; ranges stored before the flag existed are derived from their summary. */
export function isHostBlockRange(range: { hostBlock?: boolean; summary?: string | null }): boolean {
  return typeof range.hostBlock === "boolean" ? range.hostBlock : isHostBlockSummary(range.summary);
}

/** Ranges that take a bed: everything except a host block. */
export function withoutHostBlocks<T extends { hostBlock?: boolean; summary?: string | null }>(ranges: readonly T[]): T[] {
  return ranges.filter((range) => !isHostBlockRange(range));
}
