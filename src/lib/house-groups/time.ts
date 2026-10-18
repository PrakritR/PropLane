/** House chat runs on the house's clock; every PropLane house is Pacific for now (see `quiet-hours` in the one-number docs). */
const PACIFIC = "America/Los_Angeles";

export const QUIET_START_HOUR = 22;
export const QUIET_END_HOUR = 8;

export function pacificHour(at: Date): number {
  const hour = new Intl.DateTimeFormat("en-US", { timeZone: PACIFIC, hour: "numeric", hour12: false }).format(at);
  return Number(hour) % 24;
}

/** The Pacific calendar day, `YYYY-MM-DD`. */
export function pacificDayKey(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: PACIFIC, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** 10 pm to 8 am Pacific: nothing posts to a house except an emergency. */
export function inHouseQuietHours(at: Date): boolean {
  const hour = pacificHour(at);
  return hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR;
}

/** The next 8:00 am Pacific at or after `at` (used to hold a night-time answer until morning). */
export function nextPacificMorning(at: Date): Date {
  // Walk forward in 15 minute steps: simple, DST-proof, and bounded to 24 hours.
  let cursor = new Date(Math.ceil(at.getTime() / 900_000) * 900_000);
  for (let i = 0; i < 100; i += 1) {
    const hour = pacificHour(cursor);
    const minute = Number(new Intl.DateTimeFormat("en-US", { timeZone: PACIFIC, minute: "numeric" }).format(cursor));
    if (hour === QUIET_END_HOUR && minute === 0) return cursor;
    cursor = new Date(cursor.getTime() + 900_000);
  }
  return new Date(at.getTime() + 12 * 3_600_000);
}

/** Start (UTC instant) of the Pacific day containing `at`. */
export function pacificDayStart(at: Date): Date {
  const key = pacificDayKey(at);
  let cursor = new Date(at.getTime());
  for (let i = 0; i < 200; i += 1) {
    const prev = new Date(cursor.getTime() - 900_000);
    if (pacificDayKey(prev) !== key) return cursor;
    cursor = prev;
  }
  return cursor;
}
