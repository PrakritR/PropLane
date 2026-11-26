import type { IcalDateRange } from "@/lib/ical/types";

function formatIcsUtcStamp(date: Date): string {
  const y = date.getUTCFullYear();
  const mo = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const h = String(date.getUTCHours()).padStart(2, "0");
  const mi = String(date.getUTCMinutes()).padStart(2, "0");
  const s = String(date.getUTCSeconds()).padStart(2, "0");
  return `${y}${mo}${d}T${h}${mi}${s}Z`;
}

function ymdToIcalDate(ymd: string): string {
  return ymd.replace(/-/g, "");
}

function addDaysYmd(ymd: string, days: number): string {
  const [y, mo, d] = ymd.split("-").map((x) => Number(x));
  const dt = new Date(Date.UTC(y, mo - 1, d + days));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/** A bare CR would end the content line and let a name inject its own properties, so CRs never get through. */
function escapeIcsText(value: string): string {
  return value.replace(/\r/g, "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

/** Stable 32-bit FNV-1a hex of a string: the same range always gets the same UID suffix. */
function stableHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** RFC 5545 3.1: fold a content line at 75 octets (never inside a UTF-8 sequence) with CRLF + one space. */
export function foldIcsLine(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let current = "";
  let octets = 0;
  let limit = 75;
  for (const ch of line) {
    const size = encoder.encode(ch).length;
    if (octets + size > limit) {
      parts.push(current);
      current = "";
      octets = 0;
      limit = 74; // the leading space counts
    }
    current += ch;
    octets += size;
  }
  if (current) parts.push(current);
  return parts.join("\r\n ");
}

/** Build an iCalendar feed for Airbnb "Import calendar". DTEND is exclusive. */
export function generateIcsCalendar(
  ranges: IcalDateRange[],
  options?: { calendarName?: string; prodId?: string; uidPrefix?: string },
): string {
  const now = formatIcsUtcStamp(new Date());
  const name = options?.calendarName?.trim() || "PropLane availability";
  const prodId = options?.prodId?.trim() || "-//PropLane//Channel Calendar//EN";
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${prodId}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcsText(name)}`,
    // All-day events carry no zone; naming one (and a refresh hint) is what stricter importers expect to see.
    "X-WR-TIMEZONE:UTC",
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
  ];

  const seenUids = new Set<string>();
  for (const range of ranges) {
    const start = range.start.trim();
    const endInclusive = range.end.trim() || start;
    if (!start) continue;
    const dtEndExclusive = addDaysYmd(endInclusive, 1);
    // Two ranges can start the same day, so the UID carries the end date as well. Nothing else: the UID is
    // the key a channel updates an event by, so every byte of it that can change re-keys the whole feed
    // (a delete plus an add on the consumer's side). A second identical range gets a stable hashed suffix.
    const base = options?.uidPrefix ? `${options.uidPrefix}-${start}-${dtEndExclusive}` : `proplane-block-${start}-${dtEndExclusive}`;
    let uid = base;
    for (let n = 2; seenUids.has(uid); n += 1) uid = `${base}-${stableHash(`${base}|${n}`)}`;
    seenUids.add(uid);
    lines.push(
      "BEGIN:VEVENT",
      `UID:${uid}`,
      `DTSTAMP:${now}`,
      `DTSTART;VALUE=DATE:${ymdToIcalDate(start)}`,
      `DTEND;VALUE=DATE:${ymdToIcalDate(dtEndExclusive)}`,
      "SUMMARY:Blocked",
      "TRANSP:OPAQUE",
      "END:VEVENT",
    );
  }

  lines.push("END:VCALENDAR");
  return `${lines.map(foldIcsLine).join("\r\n")}\r\n`;
}
