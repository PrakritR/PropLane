import type { IcalEvent } from "@/lib/ical/types";

function unfoldIcsLines(text: string): string[] {
  const raw = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of raw) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

function parseIcsDateValue(line: string): string | null {
  const colon = line.indexOf(":");
  if (colon < 0) return null;
  const value = line.slice(colon + 1).trim();
  if (!value) return null;
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(value);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function addDaysYmd(ymd: string, days: number): string {
  const [y, mo, d] = ymd.split("-").map((x) => Number(x));
  const dt = new Date(Date.UTC(y, mo - 1, d + days));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/** iCal DATE DTEND is exclusive; convert to inclusive YYYY-MM-DD for PropLane ranges. */
function inclusiveEndFromIcalDtEnd(dtEnd: string | null, dtStart: string): string {
  if (!dtEnd) return dtStart;
  if (dtEnd <= dtStart) return dtStart;
  return addDaysYmd(dtEnd, -1);
}

function parseVeventBlock(lines: string[]): IcalEvent | null {
  let uid = "";
  let summary = "";
  let dtStart: string | null = null;
  let dtEnd: string | null = null;

  for (const line of lines) {
    const upper = line.toUpperCase();
    if (upper.startsWith("UID:")) uid = line.slice(4).trim();
    else if (upper.startsWith("SUMMARY:")) summary = line.slice(8).trim();
    else if (upper.startsWith("DTSTART")) dtStart = parseIcsDateValue(line);
    else if (upper.startsWith("DTEND")) dtEnd = parseIcsDateValue(line);
  }

  if (!dtStart) return null;
  const startDate = dtStart;
  const endDate = inclusiveEndFromIcalDtEnd(dtEnd, startDate);
  return {
    uid: uid || `${startDate}:${endDate}:${summary}`,
    summary,
    startDate,
    endDate,
  };
}

/** Parse VEVENT blocks from an iCalendar document (Airbnb export shape). */
export function parseIcsCalendar(text: string): IcalEvent[] {
  const lines = unfoldIcsLines(text);
  const events: IcalEvent[] = [];
  let inEvent = false;
  let block: string[] = [];

  for (const line of lines) {
    const upper = line.trim().toUpperCase();
    if (upper === "BEGIN:VEVENT") {
      inEvent = true;
      block = [];
      continue;
    }
    if (upper === "END:VEVENT") {
      if (inEvent) {
        const parsed = parseVeventBlock(block);
        if (parsed) events.push(parsed);
      }
      inEvent = false;
      block = [];
      continue;
    }
    if (inEvent) block.push(line);
  }

  return events;
}
