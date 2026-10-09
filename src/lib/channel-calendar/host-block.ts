/**
 * A host's own calendar block, as a channel exports it ("Airbnb (Not available)"), is not a
 * reservation: no guest holds the bed. It still closes the dates on the channel, so the Bookings
 * calendar shows it as a block, but it must never count toward room capacity or be exported back.
 * "Reserved" is a real booking and is deliberately NOT matched here.
 *
 * The match is on the WHOLE summary (optionally wrapped in the channel's own name, which is how
 * Airbnb writes it) — never a substring. Booking.com and VRBO privacy-strip real reservations to
 * "CLOSED - Not available", and reading one of those as a host block would publish an occupied
 * room as free.
 */
const HOST_BLOCK_LABELS: ReadonlySet<string> = new Set(["not available", "blocked", "unavailable"]);
const CHANNEL_WRAPPED = /^[a-z0-9][a-z0-9 .&'’-]*\(([^()]+)\)$/;

export function isHostBlockSummary(summary: string | null | undefined): boolean {
  const raw = String(summary ?? "").trim().toLowerCase();
  if (!raw) return false;
  if (HOST_BLOCK_LABELS.has(raw)) return true;
  const wrapped = CHANNEL_WRAPPED.exec(raw);
  return wrapped ? HOST_BLOCK_LABELS.has(wrapped[1]!.trim()) : false;
}

/** The stored flag wins; ranges stored before the flag existed are derived from their summary. */
export function isHostBlockRange(range: { hostBlock?: boolean; summary?: string | null }): boolean {
  return typeof range.hostBlock === "boolean" ? range.hostBlock : isHostBlockSummary(range.summary);
}

/** Ranges that take a bed: everything except a host block. */
export function withoutHostBlocks<T extends { hostBlock?: boolean; summary?: string | null }>(ranges: readonly T[]): T[] {
  return ranges.filter((range) => !isHostBlockRange(range));
}
