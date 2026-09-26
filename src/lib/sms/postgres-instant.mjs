/** Parse the ISO timestamptz forms used by PostgreSQL without dropping microseconds.
 * Invalid dates, missing offsets, and precision beyond PostgreSQL's six digits fail closed.
 * @param {unknown} value
 * @returns {bigint | null}
 */
export function postgresInstantMicros(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)$/i.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, fraction = "", zone] = match;
  const numbers = [year, month, day, hour, minute, second].map(Number);
  const [y, m, d, h, min, sec] = numbers;
  if (m < 1 || m > 12 || d < 1 || d > 31 || h > 23 || min > 59 || sec > 59) return null;
  const calendar = new Date(0);
  calendar.setUTCFullYear(y, m - 1, d);
  calendar.setUTCHours(h, min, sec, 0);
  if (calendar.getUTCFullYear() !== y || calendar.getUTCMonth() !== m - 1 || calendar.getUTCDate() !== d) return null;
  let offsetMinutes = 0;
  if (zone.toUpperCase() !== "Z") {
    const sign = zone[0] === "+" ? 1 : -1;
    const digits = zone.slice(1).replace(":", "");
    const hours = Number(digits.slice(0, 2));
    const minutes = digits.length === 4 ? Number(digits.slice(2)) : 0;
    if (hours > 15 || minutes > 59 || (hours === 15 && minutes > 59)) return null;
    offsetMinutes = sign * (hours * 60 + minutes);
  }
  return BigInt(calendar.getTime() - offsetMinutes * 60_000) * 1000n + BigInt(fraction.padEnd(6, "0") || "0");
}

/** @param {unknown} left @param {unknown} right */
export function samePostgresInstant(left, right) {
  const a = postgresInstantMicros(left);
  return a !== null && a === postgresInstantMicros(right);
}
