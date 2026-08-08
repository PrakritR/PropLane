/** Inclusive YYYY-MM-DD range check for channel booking dates. */
export function dateKeyInBookingRange(dateKey: string, start: string, end: string): boolean {
  const day = dateKey.trim();
  const rangeStart = start.trim();
  const rangeEnd = (end || start).trim();
  if (!day || !rangeStart) return false;
  return day >= rangeStart && day <= rangeEnd;
}
