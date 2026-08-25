/**
 * One resident per email address.
 *
 * The Residents list is derived 1:1 from approved application rows, so a person who applied twice
 * — two rooms, or a second application after a move — appeared as TWO residents with the same
 * email. That is a real duplicate account in every surface keyed on the person rather than the
 * application: the directory, the resident picker, charges, and messaging.
 *
 * Applications deliberately stay separate. Someone may apply for several rooms and the manager
 * needs to see each one; it is only the RESIDENT identity that must collapse.
 *
 * Which row survives, in order:
 *   1. a current resident beats a previous one — a past tenancy must never hide the live one;
 *   2. then the latest lease start, because that is the placement in force after a room move;
 *   3. then a stable id compare, so the list does not reshuffle between renders.
 *
 * Rows with NO email are never collapsed. A manually added resident can legitimately have no
 * address on file, and treating "" as one shared key would merge unrelated people into a single
 * row — losing real residents, which is far worse than showing a duplicate.
 */
export type DedupableResident = {
  id: string;
  email: string;
  leaseStart: string;
  isPrevious: boolean;
};

function normalizeEmail(email: string | null | undefined): string {
  return (email ?? "").trim().toLowerCase();
}

/** True when `candidate` should replace `current` as the surviving row for an email. */
export function residentRowWins<T extends DedupableResident>(candidate: T, current: T): boolean {
  if (candidate.isPrevious !== current.isPrevious) return !candidate.isPrevious;

  const a = candidate.leaseStart?.trim() || "";
  const b = current.leaseStart?.trim() || "";
  if (a !== b) {
    // A row WITH a date beats one without; otherwise the later date wins. ISO dates compare
    // lexicographically, which is why these are not parsed.
    if (!a) return false;
    if (!b) return true;
    return a > b;
  }

  return candidate.id.localeCompare(current.id) < 0;
}

/**
 * Collapse residents so each email appears once, preserving input order for the rows that
 * survive so the caller's own sort is not disturbed.
 */
export function dedupeResidentsByEmail<T extends DedupableResident>(rows: readonly T[]): T[] {
  const winnerByEmail = new Map<string, T>();
  const noEmail: T[] = [];

  for (const row of rows) {
    const key = normalizeEmail(row.email);
    if (!key) {
      noEmail.push(row);
      continue;
    }
    const current = winnerByEmail.get(key);
    if (!current || residentRowWins(row, current)) winnerByEmail.set(key, row);
  }

  const kept = new Set<string>([...winnerByEmail.values()].map((r) => r.id));
  return rows.filter((row) => kept.has(row.id) || noEmail.includes(row));
}
