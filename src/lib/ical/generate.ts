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

function escapeIcsText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

/** Build an iCalendar feed for Airbnb "Import calendar". DTEND is exclusive. */
export function generateIcsCalendar(
  ranges: IcalDateRange[],
  options?: { calendarName?: string; prodId?: string },
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
  ];

  for (const range of ranges) {
    const start = range.start.trim();
    const endInclusive = range.end.trim() || start;
    if (!start) continue;
    const dtEndExclusive = addDaysYmd(endInclusive, 1);
    const uid = `proplane-block-${start}-${dtEndExclusive}`;
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
  return `${lines.join("\r\n")}\r\n`;
}
