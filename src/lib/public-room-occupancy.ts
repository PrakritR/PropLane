/** Anonymous aggregate capacity spans, never application/resident identities. */
export type PublicRoomOccupancy = { roomChoice: string; spans: { start: string; end: string | null; count: number }[] };
export function aggregateRoomOccupancy(placements: { start: string; end: string | null; count?: number }[]): PublicRoomOccupancy["spans"] {
  const changes = new Map<string, number>();
  const bump = (day: string, count: number) => changes.set(day, (changes.get(day) ?? 0) + count);
  for (const row of placements) {
    bump(row.start, row.count ?? 1);
    if (row.end && row.end < "9999-12-31") { const day = new Date(`${row.end}T12:00:00Z`); day.setUTCDate(day.getUTCDate() + 1); bump(day.toISOString().slice(0, 10), -(row.count ?? 1)); }
  }
  const dates = [...changes.keys()].sort(); let count = 0;
  const spans: PublicRoomOccupancy["spans"] = [];
  dates.forEach((day, index) => {
    count += changes.get(day) ?? 0;
    if (!count) return;
    const next = dates[index + 1]; const end = next ? new Date(`${next}T12:00:00Z`) : null;
    if (end) end.setUTCDate(end.getUTCDate() - 1);
    spans.push({ start: day, end: end?.toISOString().slice(0, 10) ?? null, count });
  });
  return spans;
}
