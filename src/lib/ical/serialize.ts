/**
 * Pure RFC 5545 serializer for timed events (the existing `generate.ts` only
 * writes all-day availability blocks). No I/O, no env: callers hand it the
 * already-privacy-filtered event list, so what this prints is exactly what a
 * subscriber sees. An event that carries no `location` prints no LOCATION line.
 */

export type IcsTimedEvent = {
  /** Stable across fetches so a calendar app updates an event instead of duplicating it. */
  uid: string;
  summary: string;
  start: Date;
  end: Date;
  location?: string | null;
  description?: string | null;
};

/** A bare CR would end the content line and let a title inject its own properties, so CRs never get through. */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

/** UID/ids are single tokens; strip anything that could end the line or add a parameter. */
function safeUid(value: string): string {
  return value.replace(/[\r\n;:,\\\s]/g, "-");
}

export function formatIcsUtc(date: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${p(date.getUTCFullYear(), 4)}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `T${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`
  );
}

/** Fold a content line at 75 octets (never inside a multi-byte character); continuations start with one space. */
export function foldIcsLine(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let current = "";
  let currentBytes = 0;
  let limit = 75;
  for (const char of line) {
    const bytes = encoder.encode(char).length;
    if (currentBytes + bytes > limit) {
      parts.push(current);
      current = "";
      currentBytes = 0;
      limit = 74; // the leading space of a continuation counts toward the 75
    }
    current += char;
    currentBytes += bytes;
  }
  if (current) parts.push(current);
  return parts.join("\r\n ");
}

export function buildIcsTimedCalendar(
  events: readonly IcsTimedEvent[],
  options: { calendarName: string; prodId?: string; now?: Date },
): string {
  const stamp = formatIcsUtc(options.now ?? new Date());
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${options.prodId ?? "-//PropLane//Vendor Jobs//EN"}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcsText(options.calendarName)}`,
  ];
  for (const event of events) {
    if (Number.isNaN(event.start.getTime()) || Number.isNaN(event.end.getTime())) continue;
    lines.push(
      "BEGIN:VEVENT",
      `UID:${safeUid(event.uid)}`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${formatIcsUtc(event.start)}`,
      `DTEND:${formatIcsUtc(event.end)}`,
      `SUMMARY:${escapeIcsText(event.summary)}`,
    );
    const location = event.location?.trim();
    if (location) lines.push(`LOCATION:${escapeIcsText(location)}`);
    const description = event.description?.trim();
    if (description) lines.push(`DESCRIPTION:${escapeIcsText(description)}`);
    lines.push("TRANSP:OPAQUE", "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(foldIcsLine).join("\r\n")}\r\n`;
}
