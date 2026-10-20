/**
 * The pure half of booking a short stay by text: is this a short-stay ask or a long-term one, and which
 * dates did they mean. No I/O and no clock of its own: every function takes the Pacific "today"
 * (`YYYY-MM-DD`), so what the texter said and what the tools quote cannot drift.
 */
import { addRangeDays, normalizeRangeDay } from "@/lib/room-availability-range";

export type StayIntent = "short" | "long" | "unknown";

const SHORT_PHRASES = [
  /\bshort[\s-]?(term|stay)s?\b/,
  /\bnightly\b/,
  /\b(per|a|by the|each) night\b/,
  /\bairbnb\b/,
  /\bvacation rental\b/,
  /\bsublet\b/,
  /\btemporary\b/,
  /\b(a )?few (nights|days)\b/,
  /\b\d+\s*[- ]?(night|nights)\b/,
  /\b(for|just|only)\s+(a|an|one|1)\s+(night|weekend|week|month)( only)?\b/,
  /\b(for|just|only)\s+(\d+|two|three|four|five|six)\s+(days?|nights?|weeks?)\b/,
  /\b(\d+|two|three|four)\s+weeks?\b/,
  /\b(a|one|1)\s+month\s+only\b/,
  /\bfor\s+(a|one|1)\s+month\b/,
  /\bmonth[\s-]only\b/,
];

const STRONG_LONG = [/\blong[\s-]?term\b/, /\b(6|six|9|nine|12|twelve)[\s-]?(month|mo)s?\b/, /\bone[\s-]year\b/, /\ba year\b/, /\blease\b/, /\bapplication\b|\bapply\b/];

/**
 * Short stay vs long term. A text that names both is long only when the long words are the explicit ones
 * (a lease, a year, "long term") and no short phrase is spelled out as such ("short term", "nightly", "Airbnb").
 */
export function detectStayIntent(text: string): StayIntent {
  const body = text.toLowerCase().replace(/[’]/g, "'");
  const short = SHORT_PHRASES.some((re) => re.test(body));
  const long = STRONG_LONG.some((re) => re.test(body));
  const explicitShort = /\bshort[\s-]?(term|stay)s?\b|\bnightly\b|\bairbnb\b|\bper night\b|\bby the night\b/.test(body);
  if (short && long) return explicitShort ? "short" : "long";
  if (short) return "short";
  if (long) return "long";
  return "unknown";
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};
const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WORD_NUMBERS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

export type ParsedStayDates = {
  checkIn: string | null;
  checkOut: string | null;
  /** The length they named ("2 weeks", "3 nights"), when there is one. */
  nights: number | null;
};

const pad = (n: number) => String(n).padStart(2, "0");

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The next occurrence of month/day on or after `today` (this year, else next); null when not a real date. */
function nextOccurrence(month: number, day: number, today: string): string | null {
  const [ty] = today.split("-").map(Number) as [number];
  for (const year of [ty, ty + 1]) {
    if (day < 1 || day > daysInMonth(year, month)) continue;
    const key = `${year}-${pad(month)}-${pad(day)}`;
    if (key >= today) return key;
  }
  return null;
}

function weekdayOf(day: string): number {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function lengthInNights(text: string): number | null {
  const m = /\b(\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten)\s*[- ]?\s*(nights?|days?|weeks?|months?)\b/.exec(text);
  if (!m) return null;
  const count = /^\d+$/.test(m[1]!) ? Number(m[1]) : WORD_NUMBERS[m[1]!];
  if (!count) return null;
  const unit = m[2]!;
  if (unit.startsWith("week")) return count * 7;
  if (unit.startsWith("month")) return count * 30;
  return count;
}

/**
 * Pacific dates out of a text: "Nov 3-10", "november 3 to nov 10", "11/3-11/10", "tomorrow for 3 nights",
 * "next friday for a week", "for 2 weeks" (a length with no start). Check-out is exclusive, as everywhere
 * else a stay is written. A date already past this year means next year.
 */
export function parseStayDates(raw: string, today: string): ParsedStayDates {
  const text = raw.toLowerCase().replace(/[’]/g, "'").replace(/–|—/g, "-");
  let checkIn: string | null = null;
  let checkOut: string | null = null;

  const monthRange = new RegExp(`${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:-|to|through|thru|until|till)\\s*(?:${MONTH_RE}\\.?\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\b`).exec(text);
  const numericRange = /\b(\d{1,2})\/(\d{1,2})\s*(?:-|to|through|thru|until|till)\s*(?:(\d{1,2})\/)?(\d{1,2})\b/.exec(text);
  if (monthRange) {
    const m1 = MONTHS[monthRange[1]!]!;
    const d1 = Number(monthRange[2]);
    const m2 = monthRange[3] ? MONTHS[monthRange[3]]! : m1;
    const d2 = Number(monthRange[4]);
    checkIn = nextOccurrence(m1, d1, today);
    if (checkIn) {
      const startYear = Number(checkIn.slice(0, 4));
      const endYear = m2 < m1 ? startYear + 1 : startYear;
      checkOut = d2 >= 1 && d2 <= daysInMonth(endYear, m2) ? `${endYear}-${pad(m2)}-${pad(d2)}` : null;
    }
  } else if (numericRange) {
    const m1 = Number(numericRange[1]);
    const d1 = Number(numericRange[2]);
    const m2 = numericRange[3] ? Number(numericRange[3]) : m1;
    const d2 = Number(numericRange[4]);
    if (m1 >= 1 && m1 <= 12 && m2 >= 1 && m2 <= 12) {
      checkIn = nextOccurrence(m1, d1, today);
      if (checkIn) {
        const startYear = Number(checkIn.slice(0, 4));
        const endYear = m2 < m1 ? startYear + 1 : startYear;
        checkOut = d2 >= 1 && d2 <= daysInMonth(endYear, m2) ? `${endYear}-${pad(m2)}-${pad(d2)}` : null;
      }
    }
  }
  if (checkIn && checkOut && checkOut <= checkIn) checkOut = null;
  if (checkIn && checkOut) {
    const nights = Math.round((Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`)) / 86_400_000);
    return { checkIn, checkOut, nights };
  }

  if (!checkIn) {
    const single = new RegExp(`${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`).exec(text);
    const slash = /\b(\d{1,2})\/(\d{1,2})\b/.exec(text);
    if (single) checkIn = nextOccurrence(MONTHS[single[1]!]!, Number(single[2]), today);
    else if (slash && Number(slash[1]) >= 1 && Number(slash[1]) <= 12) checkIn = nextOccurrence(Number(slash[1]), Number(slash[2]), today);
  }
  if (!checkIn) {
    if (/\b(tonight|today)\b/.test(text)) checkIn = today;
    else if (/\btomorrow\b/.test(text)) checkIn = addRangeDays(today, 1);
    else {
      const wd = /\b(this|next|on)?\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/.exec(text);
      if (wd) {
        const target = WEEKDAYS.indexOf(wd[2]!);
        let ahead = (target - weekdayOf(today) + 7) % 7;
        if (ahead === 0) ahead = 7;
        checkIn = addRangeDays(today, ahead);
      }
    }
  }

  const nights = lengthInNights(text);
  if (checkIn && nights) checkOut = addRangeDays(checkIn, nights);
  return { checkIn: normalizeRangeDay(checkIn), checkOut: normalizeRangeDay(checkOut), nights: nights ?? null };
}
